import fs from 'node:fs';
import {
  applyOrderedToolEvents,
  createToolLifecycleState,
  getSessionSnapshot,
  normalizeToolLifecycleState,
  pruneToolLifecycleState,
} from './tool-lifecycle.js';
import {
  createToolEventStreamState,
  readToolEventsIncrementalFromStream,
  rotateToolEventStream,
} from './tool-event-stream.js';

export const TOOL_EVENT_REORDER_WINDOW_MS = 2000;
export const TOOL_SESSION_TTL_MS = 3600_000;
export const TOOL_EVENT_ROTATION_BYTES = 1024 * 1024;
export const TOOL_EVENT_ROTATION_DRAIN_MS = 2000;
export const STATUSLINE_LAUNCH_GUARD_MS = 5000;
export const STATUSLINE_ACTIVE_TOOL_CLEAR_GRACE_MS = 5000;

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort.
  }
}

function getToolEventPriority(eventName) {
  switch (eventName) {
    case 'prompt':
      return 10;
    case 'pre_tool':
      return 20;
    case 'post_tool':
    case 'post_tool_failure':
      return 30;
    case 'stop':
    case 'stop_failure':
    case 'idle':
      return 40;
    case 'session_clear_hint':
      return 50;
    default:
      return 100;
  }
}

function sortToolEvents(events) {
  events.sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    const priorityDiff = getToolEventPriority(left.event) - getToolEventPriority(right.event);
    if (priorityDiff !== 0) return priorityDiff;
    return (left._arrival_seq || 0) - (right._arrival_seq || 0);
  });
}

export function canTreatPaneAsRecovered(interactiveState) {
  return Boolean(
    interactiveState?.captureOk &&
    interactiveState.promptVisible &&
    !interactiveState.usageOverlay &&
    !interactiveState.inProgressCapture &&
    (interactiveState.inputState === 'empty' || interactiveState.inputState === 'has_content')
  );
}

/**
 * ToolPipeline turns the hook event log into the two things the liveness system
 * acts on: api-activity.json (is the agent working, on what, since when) and the
 * watchdog candidate (which running tool may be killed).
 *
 * Two rules follow from what it is made of, both pinned by
 * __tests__/tool-pipeline.test.js:
 *
 *   - Everything it reads is written by hook processes we do not control, so a
 *     bad file must degrade this pipeline and nothing else. A throw out of
 *     tick() is caught and logged by the monitor loop, which means the rest of
 *     that tick — the status file write, the tool watchdog, the task scheduler —
 *     never runs. `yos status` then shows a "Last check" that never advances,
 *     which reads as a dead machine. (The guardian that restarts a genuinely
 *     dead agent runs earlier in the tick and is not affected.)
 *
 *   - When it cannot tell what the agent is doing it must say so, rather than
 *     publish `active_tools: 0` — a reading of "I don't know" and a reading of
 *     "definitely idle" lead to opposite actions downstream. Hence
 *     `activity_known` on every snapshot.
 *
 * Writes stay best-effort — a full disk must not stop the tick — but they are no
 * longer silent. A frozen api-activity.json that nobody is told about is a
 * liveness picture that quietly stops being true.
 */
export class ToolPipeline {
  constructor({
    files,
    toolRules = [],
    runtimeLaunchAtMs = () => 0,
    isPidAlive = () => false,
    log = () => {},
  } = {}) {
    this.files = files;
    this.toolRules = toolRules;
    this.runtimeLaunchAtMs = runtimeLaunchAtMs;
    this.isPidAlive = isPidAlive;
    this.log = log;
    this.faults = new Map();
    this.reset();
  }

  /**
   * Report a persistent fault without turning the log into a metronome: once
   * when it starts, then at 4x backoff for as long as it lasts.
   */
  reportFault(key, message) {
    const existing = this.faults.get(key);
    if (existing && existing.message === message) {
      existing.ticks += 1;
      if (existing.ticks < existing.nextReportAt) return;
      existing.nextReportAt = existing.ticks * 4;
      this.log(`${message} (still failing after ${existing.ticks} ticks)`);
      return;
    }
    this.faults.set(key, { message, ticks: 1, nextReportAt: 4 });
    this.log(message);
  }

  /** Clear a fault, saying so only if it had been reported. */
  clearFault(key, recoveryMessage) {
    if (!this.faults.has(key)) return;
    this.faults.delete(key);
    if (recoveryMessage) this.log(recoveryMessage);
  }

  reset({ clearFiles = false } = {}) {
    this.lifecycleState = createToolLifecycleState();
    this.streamState = createToolEventStreamState(this.files.toolEvents);
    this.activeTail = '';
    this.rotatedTail = '';
    this.arrivalSeq = 0;
    this.reorderBuffer = [];
    this.lastStatuslineSyntheticClearAt = 0;
    this.apiActivity = null;
    this.foregroundIdentity = null;

    if (clearFiles) {
      try {
        fs.writeFileSync(this.files.toolEvents, '');
      } catch {
        // Best-effort.
      }
      safeUnlink(this.files.toolEventStreamState);
      safeUnlink(this.files.sessionToolState);
      safeUnlink(this.files.foregroundSession);
      safeUnlink(`${this.files.toolEvents}.old`);
      return;
    }

    const loadedStreamState = this.loadPersistedToolEventStreamState();
    if (!loadedStreamState) return;

    const loadedSessionState = this.readJsonFileSafe(this.files.sessionToolState);
    if (!loadedSessionState || loadedSessionState.version !== 1) return;

    this.streamState = loadedStreamState;
    this.lifecycleState = normalizeToolLifecycleState(loadedSessionState);
  }

  tick({ nowMs, currentTmuxClaudePid = 0, interactiveState = null } = {}) {
    // Each stage is contained on its own. A hook that writes a malformed file
    // costs us this pipeline's accuracy for one tick; it must not cost the
    // status file, the tool watchdog and the task scheduler their whole tick.
    let degraded = false;

    try {
      this.processToolLifecycle(nowMs, currentTmuxClaudePid, interactiveState);
      this.clearFault('lifecycle', 'Tool lifecycle processing recovered');
    } catch (err) {
      degraded = true;
      this.reportFault('lifecycle', `Tool lifecycle processing failed: ${err?.message || err}`);
    }

    try {
      this.foregroundIdentity = this.resolveTrustedForegroundIdentity(currentTmuxClaudePid);
      this.clearFault('foreground', 'Foreground identity resolution recovered');
    } catch (err) {
      degraded = true;
      this.reportFault('foreground', `Foreground identity resolution failed: ${err?.message || err}`);
      this.foregroundIdentity = {
        trusted: false,
        sessionId: null,
        claudePid: 0,
        source: null,
        observedAt: 0,
        blockReason: 'identity_resolution_failed',
      };
    }

    try {
      this.apiActivity = this.buildApiActivity(this.foregroundIdentity, currentTmuxClaudePid, {
        activityKnown: !degraded,
      });
      this.clearFault('api_activity_build', 'Api activity snapshot recovered');
    } catch (err) {
      this.reportFault('api_activity_build', `Api activity snapshot failed: ${err?.message || err}`);
      this.apiActivity = this.buildUnknownApiActivity(currentTmuxClaudePid);
    }

    this.writeSessionToolState(
      this.foregroundIdentity,
      this.foregroundIdentity?.trusted ? this.foregroundIdentity.sessionId : null
    );
    this.writeApiActivitySnapshot(this.apiActivity);
    this.maybeRotateToolEventStream(
      nowMs,
      this.foregroundIdentity?.trusted ? this.foregroundIdentity.sessionId : null
    );
    return {
      foregroundIdentity: this.foregroundIdentity,
      apiActivity: this.apiActivity,
    };
  }

  getApiActivity() {
    return this.apiActivity;
  }

  getForegroundIdentity() {
    return this.foregroundIdentity;
  }

  getRuleById(ruleId) {
    if (!ruleId) return null;
    if (!Array.isArray(this.toolRules)) return null;
    return this.toolRules.find((rule) => rule?.id === ruleId) || null;
  }

  writeApiActivitySnapshot(apiActivity) {
    // Best-effort, but not silent: external readers of api-activity.json have
    // no way to tell a frozen snapshot from a quiet agent.
    try {
      atomicWriteJson(this.files.apiActivity, apiActivity);
      this.clearFault('write_api_activity', 'Api activity snapshot is being written again');
    } catch (err) {
      this.reportFault('write_api_activity', `Failed to write api activity snapshot: ${err?.message || err}`);
    }
  }

  writeSessionToolState(foregroundIdentity, foregroundSessionId) {
    try {
      const sessions = {};
      for (const sessionId of Object.keys(this.lifecycleState.sessions).sort()) {
        const snapshot = getSessionSnapshot(this.lifecycleState, sessionId, foregroundSessionId);
        if (!snapshot) continue;
        sessions[sessionId] = {
          ...snapshot,
          watchdog_candidate: snapshot.running_tools.find((tool) => {
            const rule = this.getRuleById(tool.rule_id);
            return Boolean(rule?.watchdog?.enabled);
          }) || null
        };
      }

      atomicWriteJson(this.files.sessionToolState, {
        version: 1,
        foreground_source: foregroundIdentity?.source || null,
        foreground_session_id: foregroundSessionId || null,
        sessions,
        pending_completions: this.lifecycleState.pending_completions,
        pending_clear_hints: this.lifecycleState.pending_clear_hints,
      });
      this.clearFault('write_session_tool_state', 'Session tool state is being written again');
    } catch (err) {
      this.reportFault('write_session_tool_state', `Failed to write session tool state: ${err?.message || err}`);
    }
  }

  applySyntheticClearHint(sessionId, pid, reason, nowMs) {
    applyOrderedToolEvents(this.lifecycleState, [{
      ts: nowMs,
      pid: pid || 0,
      session_id: sessionId,
      event: 'session_clear_hint',
      reason,
      match_slack_ms: TOOL_EVENT_REORDER_WINDOW_MS,
    }], { nowMs });
  }

  readJsonFileSafe(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  loadPersistedToolEventStreamState() {
    const persisted = this.readJsonFileSafe(this.files.toolEventStreamState);
    if (!persisted || persisted.version !== 1) return null;
    try {
      if (!fs.existsSync(this.files.toolEvents)) return null;
      const stat = fs.statSync(this.files.toolEvents);
      const inode = Number(stat.ino) || 0;
      if (persisted.inode && persisted.inode !== inode) return null;
      if (stat.size < (Number(persisted.offset) || 0)) return null;

      const loaded = {
        ...createToolEventStreamState(this.files.toolEvents),
        inode,
        offset: Number(persisted.offset) || 0,
        last_processed_at: Number(persisted.last_processed_at) || 0,
        last_rotation_at: Number(persisted.last_rotation_at) || 0,
      };

      const rotatedDrain = persisted.rotated_drain;
      if (rotatedDrain?.path && fs.existsSync(rotatedDrain.path)) {
        const rotatedStat = fs.statSync(rotatedDrain.path);
        const rotatedInode = Number(rotatedStat.ino) || 0;
        const rotatedOffset = Number(rotatedDrain.offset) || 0;
        if ((!rotatedDrain.inode || rotatedDrain.inode === rotatedInode) && rotatedStat.size >= rotatedOffset) {
          loaded.rotated_drain = {
            path: rotatedDrain.path,
            inode: rotatedInode,
            offset: rotatedOffset,
            last_size: Math.max(Number(rotatedDrain.last_size) || 0, rotatedOffset),
            quiet_since: Number(rotatedDrain.quiet_since) || loaded.last_rotation_at || 0,
          };
        }
      }

      if (!loaded.offset && !loaded.rotated_drain) return null;
      return loaded;
    } catch {
      return null;
    }
  }

  readForegroundSessionRecord() {
    const data = this.readJsonFileSafe(this.files.foregroundSession);
    if (!data || !data.session_id) return null;
    return {
      sessionId: String(data.session_id),
      claudePid: Number(data.claude_pid) || 0,
      source: data.source || 'session_start',
      observedAt: Number(data.observed_at) || 0,
    };
  }

  readStatuslineRecord() {
    try {
      if (!fs.existsSync(this.files.statusline)) return null;
      const stat = fs.statSync(this.files.statusline);
      const data = JSON.parse(fs.readFileSync(this.files.statusline, 'utf8'));
      if (!data?.session_id) return null;
      return {
        sessionId: String(data.session_id),
        observedAt: Math.floor(stat.mtimeMs),
      };
    } catch {
      return null;
    }
  }

  resolveTrustedForegroundIdentity(currentTmuxClaudePid) {
    const early = this.readForegroundSessionRecord();
    const statusline = this.readStatuslineRecord();
    const launchGuardFloor = Math.max(0, this.runtimeLaunchAtMs() - STATUSLINE_LAUNCH_GUARD_MS);

    const earlyTrusted = Boolean(
      early &&
      early.observedAt >= launchGuardFloor &&
      this.isPidAlive(early.claudePid) &&
      (!currentTmuxClaudePid || early.claudePid === currentTmuxClaudePid)
    );

    const statuslineFresh = Boolean(
      statusline &&
      statusline.observedAt >= launchGuardFloor
    );

    if (statuslineFresh && currentTmuxClaudePid > 0) {
      return {
        trusted: true,
        sessionId: statusline.sessionId,
        claudePid: currentTmuxClaudePid,
        source: earlyTrusted && early.sessionId === statusline.sessionId
          ? 'session_start+statusline'
          : 'statusline',
        observedAt: statusline.observedAt,
        blockReason: null,
      };
    }

    if (earlyTrusted) {
      return {
        trusted: true,
        sessionId: early.sessionId,
        claudePid: early.claudePid,
        source: early.source || 'session_start',
        observedAt: early.observedAt,
        blockReason: null,
      };
    }

    if (statusline && !statuslineFresh) {
      return {
        trusted: false,
        sessionId: statusline.sessionId,
        claudePid: 0,
        source: 'statusline',
        observedAt: statusline.observedAt,
        blockReason: 'stale_statusline',
      };
    }

    if (statusline && currentTmuxClaudePid <= 0) {
      return {
        trusted: false,
        sessionId: statusline.sessionId,
        claudePid: 0,
        source: 'statusline',
        observedAt: statusline.observedAt,
        blockReason: 'missing_tmux_claude_pid',
      };
    }

    return {
      trusted: false,
      sessionId: null,
      claudePid: 0,
      source: null,
      observedAt: 0,
      blockReason: 'missing_foreground_identity',
    };
  }

  readToolEventsIncremental(nowMs) {
    const result = readToolEventsIncrementalFromStream({
      filePath: this.files.toolEvents,
      streamState: this.streamState,
      activeTail: this.activeTail,
      rotatedTail: this.rotatedTail,
      arrivalSeq: this.arrivalSeq,
      nowMs,
      drainQuietMs: TOOL_EVENT_ROTATION_DRAIN_MS,
      log: this.log,
    });
    this.streamState = result.streamState;
    this.activeTail = result.activeTail;
    this.rotatedTail = result.rotatedTail;
    this.arrivalSeq = result.arrivalSeq;
    return result.events;
  }

  maybeBuildStatuslineClearHint(currentTmuxClaudePid, interactiveState) {
    const statusline = this.readStatuslineRecord();
    if (!statusline?.sessionId) return null;
    if (statusline.observedAt < Math.max(0, this.runtimeLaunchAtMs() - STATUSLINE_LAUNCH_GUARD_MS)) return null;
    if (statusline.observedAt <= this.lastStatuslineSyntheticClearAt) return null;
    if (!canTreatPaneAsRecovered(interactiveState)) return null;
    const session = getSessionSnapshot(this.lifecycleState, statusline.sessionId, statusline.sessionId);
    const runningTools = session?.running_tools || [];
    if (runningTools.length === 0) return null;
    const newestStartedAt = Number(runningTools[runningTools.length - 1]?.started_at) || 0;
    if (newestStartedAt > 0 && statusline.observedAt < (newestStartedAt + STATUSLINE_ACTIVE_TOOL_CLEAR_GRACE_MS)) {
      return null;
    }
    this.lastStatuslineSyntheticClearAt = statusline.observedAt;
    return {
      ts: statusline.observedAt,
      pid: currentTmuxClaudePid || 0,
      session_id: statusline.sessionId,
      event: 'session_clear_hint',
      reason: 'statusline_turn_complete',
      match_slack_ms: TOOL_EVENT_REORDER_WINDOW_MS,
      _arrival_seq: ++this.arrivalSeq,
    };
  }

  collectLiveSessionPids() {
    const livePids = new Set();
    for (const session of Object.values(this.lifecycleState.sessions)) {
      const pid = Number(session?.pid) || 0;
      if (this.isPidAlive(pid)) livePids.add(pid);
    }
    return livePids;
  }

  processToolLifecycle(nowMs, currentTmuxClaudePid, interactiveState) {
    const newEvents = this.readToolEventsIncremental(nowMs);
    const syntheticClear = this.maybeBuildStatuslineClearHint(currentTmuxClaudePid, interactiveState);
    if (syntheticClear) newEvents.push(syntheticClear);
    if (newEvents.length > 0) {
      this.reorderBuffer.push(...newEvents);
      sortToolEvents(this.reorderBuffer);
    }

    const flushBefore = nowMs - TOOL_EVENT_REORDER_WINDOW_MS;
    const flushable = [];
    const deferred = [];
    for (const event of this.reorderBuffer) {
      if ((event.ts || 0) <= flushBefore) {
        flushable.push(event);
      } else {
        deferred.push(event);
      }
    }
    this.reorderBuffer = deferred;

    if (flushable.length > 0) {
      applyOrderedToolEvents(this.lifecycleState, flushable, { nowMs });
    }

    pruneToolLifecycleState(this.lifecycleState, {
      nowMs,
      livePids: this.collectLiveSessionPids(),
      sessionTtlMs: TOOL_SESSION_TTL_MS
    });

    this.writeToolEventStreamState();
  }

  writeToolEventStreamState() {
    // An offset that never persists means every monitor restart re-reads the
    // whole event log from byte zero, so a silent failure here is expensive.
    try {
      atomicWriteJson(this.files.toolEventStreamState, this.streamState);
      this.clearFault('write_stream_state', 'Tool event stream state is being written again');
    } catch (err) {
      this.reportFault('write_stream_state', `Failed to write tool event stream state: ${err?.message || err}`);
    }
  }

  maybeRotateToolEventStream(nowMs, foregroundSessionId) {
    try {
      if (!fs.existsSync(this.files.toolEvents)) return;
      const stat = fs.statSync(this.files.toolEvents);
      if (stat.size < TOOL_EVENT_ROTATION_BYTES) return;

      const hasAnyActiveTools = Object.keys(this.lifecycleState.sessions).some((sessionId) => {
        const snapshot = getSessionSnapshot(this.lifecycleState, sessionId, foregroundSessionId);
        return Boolean(snapshot?.running_tools?.length);
      });
      const hasPendingBuffers = this.lifecycleState.pending_completions.length > 0 || this.lifecycleState.pending_clear_hints.length > 0;

      // Every one of these is a good reason to wait — rotating with events in
      // flight loses them. But an oversized log that stays oversized is a disk
      // filling up in silence, so the reason gets said out loud.
      const blockedBy =
        hasAnyActiveTools ? 'a running tool is still in flight'
        : hasPendingBuffers ? 'buffered completions or clear hints are still pending'
        : this.reorderBuffer.length > 0 ? `${this.reorderBuffer.length} event(s) still inside the reorder window`
        : this.activeTail ? 'the active log ends on a partial line'
        : this.rotatedTail ? 'the previously rotated log ends on a partial line'
        : this.streamState.rotated_drain ? 'the previous rotation is still draining'
        : null;

      if (blockedBy) {
        this.reportFault(
          'rotation_blocked',
          `Tool event stream: rotation blocked at ${Math.round(stat.size / 1024)}KB — ${blockedBy}`
        );
        return;
      }
      this.clearFault('rotation_blocked');

      this.streamState = rotateToolEventStream({
        filePath: this.files.toolEvents,
        nowMs,
      });
      this.activeTail = '';
      this.rotatedTail = '';
      this.writeToolEventStreamState();
      this.log('Tool event stream: rotated event log');
    } catch (err) {
      this.log(`Tool event stream rotation failed: ${err.message}`);
    }
  }

  /**
   * The snapshot every liveness decision downstream is made from.
   *
   * @param {object|null} foregroundIdentity
   * @param {number} currentTmuxClaudePid
   * @param {object} [opts]
   * @param {boolean} [opts.activityKnown] - false when this tick degraded, so
   *   the zeros below mean "could not tell" rather than "nothing is running".
   */
  buildApiActivity(foregroundIdentity, currentTmuxClaudePid, { activityKnown } = {}) {
    const sessionId = foregroundIdentity?.trusted ? foregroundIdentity.sessionId : null;
    const session = sessionId ? getSessionSnapshot(this.lifecycleState, sessionId, sessionId) : null;
    const runningTools = session?.running_tools || [];
    const oldestActiveTool = runningTools[0] || null;
    const watchdogCandidate = runningTools.find((tool) => {
      const rule = this.getRuleById(tool.rule_id);
      return Boolean(rule?.watchdog?.enabled);
    }) || null;
    const pid = foregroundIdentity?.claudePid || session?.pid || currentTmuxClaudePid || 0;

    return {
      version: 3,
      pid,
      sessionId: sessionId || null,
      scope: sessionId ? 'foreground' : null,
      foreground_identity: {
        session_id: foregroundIdentity?.sessionId || null,
        source: foregroundIdentity?.source || null,
        trusted: Boolean(foregroundIdentity?.trusted),
        observed_at: foregroundIdentity?.observedAt || 0,
      },
      event: session?.last_event || null,
      tool: watchdogCandidate?.name || oldestActiveTool?.name || session?.last_completed_tool?.name || null,
      // false here means the fields below are a guess, not an observation.
      // Both conditions must hold: we knew which session was in front, and
      // nothing in this tick degraded on the way to reading it.
      activity_known: Boolean(foregroundIdentity?.trusted) && (activityKnown ?? true),
      active: Boolean(runningTools.length > 0 || session?.in_prompt),
      active_tools: runningTools.length,
      in_prompt: Boolean(session?.in_prompt),
      updated_at: session?.last_event_at || 0,
      oldest_active_tool: oldestActiveTool ? {
        event_id: oldestActiveTool.event_id,
        name: oldestActiveTool.name,
        rule_id: oldestActiveTool.rule_id,
        started_at: oldestActiveTool.started_at,
        summary: oldestActiveTool.summary,
      } : null,
      watchdog_candidate_tool: watchdogCandidate ? {
        event_id: watchdogCandidate.event_id,
        name: watchdogCandidate.name,
        rule_id: watchdogCandidate.rule_id,
        started_at: watchdogCandidate.started_at,
        summary: watchdogCandidate.summary,
      } : null,
      last_completed_tool: session?.last_completed_tool || null,
    };
  }

  /**
   * The snapshot to publish when even building a snapshot failed. It is shaped
   * like the real one so no reader has to special-case it, and it is explicit
   * that nothing in it was observed.
   */
  buildUnknownApiActivity(currentTmuxClaudePid) {
    return {
      version: 3,
      pid: currentTmuxClaudePid || 0,
      sessionId: null,
      scope: null,
      foreground_identity: {
        session_id: null,
        source: null,
        trusted: false,
        observed_at: 0,
      },
      event: null,
      tool: null,
      activity_known: false,
      active: false,
      active_tools: 0,
      in_prompt: false,
      updated_at: 0,
      oldest_active_tool: null,
      watchdog_candidate_tool: null,
      last_completed_tool: null,
    };
  }
}
