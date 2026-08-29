import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { ToolPipeline, canTreatPaneAsRecovered } from '../tool-pipeline.js';

import { makeTempDir } from '../../../../test/helpers/temp-dir.js';

/**
 * Why this file exists.
 *
 * ToolPipeline turns the raw hook event log into the two things the liveness
 * system acts on: api-activity.json (is the agent working, on what, since
 * when) and the watchdog candidate (which running tool is allowed to be
 * killed). tool-lifecycle.js and tool-event-stream.js underneath are both
 * tested; this 527-line layer that drives them was not.
 *
 * What that layer can get wrong, and what it costs:
 *
 *   - It parses files written by hook processes we do not control. Until
 *     2026-08-27 a single bad read threw straight out of tick(), and the
 *     monitor loop's catch-and-log meant the whole rest of the tick was
 *     skipped: agent-status.json stopped being written, the tool watchdog
 *     stopped evaluating, the task scheduler stopped dispatching. `yos status`
 *     then shows a "Last check" that never advances, which reads as "this
 *     machine died hours ago" about a machine that is fine — the exact
 *     misreading TD-270 already cost us once. (The guardian that restarts a
 *     dead agent runs earlier in the tick and was never affected.)
 *
 *   - When it cannot identify the foreground session it published
 *     `active: false, active_tools: 0, updated_at: 0` — "I don't know" dressed
 *     up as "definitely idle". Downstream cannot tell the two apart.
 *
 *   - Every write of the three state files was `catch {}`. api-activity.json
 *     silently freezing means external readers see a stale snapshot forever;
 *     tool-event-stream-state.json silently failing means every monitor
 *     restart replays the entire event log from byte zero.
 *
 *   - Log rotation declining to run was also silent, so a file that is over
 *     the rotation size and staying there produces no signal at all.
 *
 * Event shapes below are copied from a real tool-events.jsonl.
 */

let dir;
let files;
let logs;
let alivePids;
let launchAtMs;

const SESSION = '85211cad-e030-49b2-9533-cd619e379700';
const PID = 1869;
const T0 = 1_787_821_000_000;

beforeEach(() => {
  dir = makeTempDir('tool-pipeline-');
  files = {
    toolEvents: path.join(dir, 'tool-events.jsonl'),
    toolEventStreamState: path.join(dir, 'tool-event-stream-state.json'),
    sessionToolState: path.join(dir, 'session-tool-state.json'),
    apiActivity: path.join(dir, 'api-activity.json'),
    foregroundSession: path.join(dir, 'foreground-session.json'),
    statusline: path.join(dir, 'statusline.json'),
  };
  fs.writeFileSync(files.toolEvents, '');
  logs = [];
  alivePids = new Set([PID]);
  launchAtMs = T0 - 60_000;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const WATCHDOG_RULE = {
  id: 'web-fetch',
  watchdog: { enabled: true, maxRuntimeSec: 120, interruptKey: 'Escape', interruptGraceSec: 30, cooldownSec: 60, escalation: 'recovery' },
};
const PLAIN_RULE = { id: 'bash', watchdog: { enabled: false } };

function makePipeline(overrides = {}) {
  return new ToolPipeline({
    files,
    toolRules: [WATCHDOG_RULE, PLAIN_RULE],
    runtimeLaunchAtMs: () => launchAtMs,
    isPidAlive: (pid) => alivePids.has(pid),
    log: (msg) => logs.push(msg),
    ...overrides,
  });
}

/** Append hook events exactly as the hooks write them. */
function appendEvents(...events) {
  fs.appendFileSync(files.toolEvents, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const preTool = (ts, eventId, tool = 'Bash', ruleId) => ({
  ts, pid: PID, session_id: SESSION, event: 'pre_tool', tool, event_id: eventId,
  summary: { type: 'command-head', value: 'cd' },
  ...(ruleId ? { rule_id: ruleId } : {}),
});
const postTool = (ts, eventId, tool = 'Bash') => ({
  ts, pid: PID, session_id: SESSION, event: 'post_tool', tool, event_id: eventId,
  summary: { type: 'command-head', value: 'cd' },
});

/** Make the foreground identity trusted the way a real machine does. */
function writeStatusline(observedAtMs, sessionId = SESSION) {
  fs.writeFileSync(files.statusline, JSON.stringify({ session_id: sessionId }));
  fs.utimesSync(files.statusline, new Date(observedAtMs), new Date(observedAtMs));
}

function writeForegroundSession(observedAtMs, sessionId = SESSION, claudePid = PID) {
  fs.writeFileSync(files.foregroundSession, JSON.stringify({
    session_id: sessionId, claude_pid: claudePid, source: 'session_start', observed_at: observedAtMs,
  }));
}

describe('ToolPipeline — the running-tool picture it publishes', () => {
  it('reports a tool as running once its pre_tool clears the reorder window', () => {
    writeStatusline(T0);
    const p = makePipeline();

    appendEvents(preTool(T0, 'evt-1'));
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    assert.equal(apiActivity.active, true);
    assert.equal(apiActivity.active_tools, 1);
    assert.equal(apiActivity.oldest_active_tool.event_id, 'evt-1');
    assert.equal(apiActivity.scope, 'foreground');
  });

  it('holds an event inside the 2s reorder window before acting on it', () => {
    writeStatusline(T0);
    const p = makePipeline();

    appendEvents(preTool(T0 + 2500, 'evt-1'));
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    assert.equal(apiActivity.active_tools, 0, 'a post_tool may still be about to arrive out of order');
  });

  it('clears the tool when its post_tool lands', () => {
    writeStatusline(T0);
    const p = makePipeline();

    appendEvents(preTool(T0, 'evt-1'), postTool(T0 + 100, 'evt-1'));
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    assert.equal(apiActivity.active_tools, 0);
    assert.equal(apiActivity.last_completed_tool.event_id, 'evt-1');
  });

  it('names the watchdog-eligible tool, not merely the oldest one', () => {
    writeStatusline(T0);
    const p = makePipeline();

    appendEvents(
      preTool(T0, 'evt-old', 'Bash', 'bash'),
      preTool(T0 + 10, 'evt-web', 'WebFetch', 'web-fetch'),
    );
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    assert.equal(apiActivity.oldest_active_tool.event_id, 'evt-old');
    assert.equal(apiActivity.watchdog_candidate_tool.event_id, 'evt-web',
      'the watchdog may only ever act on a tool whose rule allows it');
    assert.equal(apiActivity.tool, 'WebFetch');
  });

  it('offers no watchdog candidate when no running tool has a watchdog rule', () => {
    writeStatusline(T0);
    const p = makePipeline();

    appendEvents(preTool(T0, 'evt-1', 'Bash', 'bash'));
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    assert.equal(apiActivity.watchdog_candidate_tool, null);
  });

  it('keeps a background session\'s tools out of the foreground picture', () => {
    writeStatusline(T0);
    const p = makePipeline();

    appendEvents({ ...preTool(T0, 'evt-bg', 'WebFetch', 'web-fetch'), session_id: 'other-session' });
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    assert.equal(apiActivity.active_tools, 0,
      'the watchdog kills the foreground agent — a background session must never nominate a victim');
    assert.equal(apiActivity.watchdog_candidate_tool, null);
  });
});

describe('ToolPipeline — "I do not know" must not be published as "idle"', () => {
  it('marks the reading as not known when no foreground identity can be established', () => {
    const p = makePipeline();
    appendEvents(preTool(T0, 'evt-1'));

    const { apiActivity, foregroundIdentity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: 0 });

    assert.equal(foregroundIdentity.trusted, false);
    assert.equal(foregroundIdentity.blockReason, 'missing_foreground_identity');
    assert.equal(apiActivity.activity_known, false,
      'active_tools: 0 here means "cannot tell", and a reader that cannot ' +
      'distinguish that from a genuinely idle agent will not look for a hang');
  });

  it('marks the reading as known once the foreground is trusted', () => {
    writeStatusline(T0);
    const p = makePipeline();
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });
    assert.equal(apiActivity.activity_known, true);
  });

  it('a trusted, genuinely idle session is known and idle', () => {
    writeStatusline(T0);
    const p = makePipeline();
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });
    assert.equal(apiActivity.active, false);
    assert.equal(apiActivity.active_tools, 0);
    assert.equal(apiActivity.activity_known, true);
  });

  it('still reports the block reason it is refusing on', () => {
    writeStatusline(T0 - 600_000); // written before this runtime launched
    const p = makePipeline();
    const { foregroundIdentity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });
    assert.equal(foregroundIdentity.trusted, false);
    assert.equal(foregroundIdentity.blockReason, 'stale_statusline');
  });
});

describe('ToolPipeline — a bad read must not take the tick down with it', () => {
  it('survives a statusline file full of garbage', () => {
    fs.writeFileSync(files.statusline, '{not json at all');
    const p = makePipeline();
    assert.doesNotThrow(() => p.tick({ nowMs: T0, currentTmuxClaudePid: PID }));
  });

  it('survives a foreground-session file full of garbage', () => {
    fs.writeFileSync(files.foregroundSession, 'nope');
    const p = makePipeline();
    assert.doesNotThrow(() => p.tick({ nowMs: T0, currentTmuxClaudePid: PID }));
  });

  it('survives an isPidAlive that throws', () => {
    writeStatusline(T0);
    writeForegroundSession(T0);
    const p = makePipeline({ isPidAlive: () => { throw new Error('procfs gone'); } });

    let result;
    assert.doesNotThrow(() => { result = p.tick({ nowMs: T0, currentTmuxClaudePid: PID }); },
      'the monitor loop only catches and logs — a throw here skips the status ' +
      'file write, the tool watchdog and the task scheduler for the whole tick');
    assert.ok(result.apiActivity, 'a degraded reading is still a reading');
    assert.equal(result.apiActivity.activity_known, false, 'and it must be marked as not known');
  });

  it('keeps reporting accurately when the tool rules are not a usable array', () => {
    writeStatusline(T0);
    const p = makePipeline({ toolRules: null });
    appendEvents(preTool(T0, 'evt-1', 'WebFetch', 'web-fetch'));

    let apiActivity;
    assert.doesNotThrow(() => { ({ apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID })); });

    // Bad rules configuration costs us watchdog eligibility, and nothing else.
    // Falling back to the degraded snapshot here would mean a config typo blinds
    // the liveness picture entirely — a much bigger loss than it should be.
    assert.equal(apiActivity.activity_known, true);
    assert.equal(apiActivity.active_tools, 1);
    assert.equal(apiActivity.oldest_active_tool.event_id, 'evt-1');
    assert.equal(apiActivity.watchdog_candidate_tool, null,
      'no usable rule means no tool is eligible to be killed');
  });

  it('says what went wrong instead of failing mutely', () => {
    writeStatusline(T0);
    writeForegroundSession(T0);
    const p = makePipeline({ isPidAlive: () => { throw new Error('procfs gone'); } });
    p.tick({ nowMs: T0, currentTmuxClaudePid: PID });
    assert.ok(logs.some((l) => l.includes('procfs gone')), `nothing logged; got ${JSON.stringify(logs)}`);
  });

  it('does not repeat the same complaint on every tick', () => {
    writeStatusline(T0);
    writeForegroundSession(T0);
    const p = makePipeline({ isPidAlive: () => { throw new Error('procfs gone'); } });
    for (let i = 0; i < 20; i++) p.tick({ nowMs: T0 + i * 15_000, currentTmuxClaudePid: PID });
    const complaints = logs.filter((l) => l.includes('procfs gone'));
    assert.ok(complaints.length >= 1, 'must say it at least once');
    assert.ok(complaints.length < 20, `must not say it 20 times; said it ${complaints.length}`);
  });

  it('recovers on its own once the fault clears', () => {
    writeStatusline(T0);
    writeForegroundSession(T0);
    let broken = true;
    const p = makePipeline({ isPidAlive: (pid) => { if (broken) throw new Error('procfs gone'); return alivePids.has(pid); } });

    p.tick({ nowMs: T0, currentTmuxClaudePid: PID });
    broken = false;
    appendEvents(preTool(T0, 'evt-1'));
    const { apiActivity } = p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    assert.equal(apiActivity.activity_known, true);
    assert.equal(apiActivity.active_tools, 1);
  });
});

describe('ToolPipeline — a state file that cannot be written must not fail mutely', () => {
  it('reports a failed api-activity write', () => {
    writeStatusline(T0);
    const p = makePipeline();
    fs.rmSync(dir, { recursive: true, force: true }); // the directory disappears under it

    assert.doesNotThrow(() => p.tick({ nowMs: T0, currentTmuxClaudePid: 0 }));
    assert.ok(logs.some((l) => /api.?activity/i.test(l)),
      'external readers would otherwise keep believing a frozen snapshot forever');
  });

  it('reports a failed stream-state write', () => {
    const p = makePipeline();
    fs.rmSync(dir, { recursive: true, force: true });

    p.tick({ nowMs: T0, currentTmuxClaudePid: 0 });
    assert.ok(logs.some((l) => /stream state/i.test(l)),
      'a stream offset that never persists means every restart replays the whole log');
  });

  it('reports a failed session-tool-state write', () => {
    const p = makePipeline();
    fs.rmSync(dir, { recursive: true, force: true });

    p.tick({ nowMs: T0, currentTmuxClaudePid: 0 });
    assert.ok(logs.some((l) => /session tool state/i.test(l)));
  });

  it('keeps ticking after a write failure rather than giving up', () => {
    const p = makePipeline();
    const saved = fs.readFileSync(files.toolEvents);
    fs.rmSync(dir, { recursive: true, force: true });
    p.tick({ nowMs: T0, currentTmuxClaudePid: 0 });

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(files.toolEvents, saved);
    writeStatusline(T0 + 1000);
    appendEvents(preTool(T0 + 1000, 'evt-1'));
    const { apiActivity } = p.tick({ nowMs: T0 + 5000, currentTmuxClaudePid: PID });
    assert.equal(apiActivity.active_tools, 1);
  });
});

describe('ToolPipeline — rotation declining to run is worth a word', () => {
  /** Push the event log past the 1MB rotation threshold. */
  function oversizeEventLog() {
    const filler = JSON.stringify({
      ts: T0 - 500_000, pid: PID, session_id: 'ancient', event: 'stop',
    }) + '\n';
    fs.writeFileSync(files.toolEvents, filler.repeat(Math.ceil((1024 * 1024) / filler.length) + 10));
  }

  it('rotates a big log when nothing is in flight', () => {
    writeStatusline(T0);
    const p = makePipeline();
    oversizeEventLog();

    p.tick({ nowMs: T0 + 10_000, currentTmuxClaudePid: PID });
    assert.ok(logs.some((l) => l.includes('rotated event log')));
  });

  it('declines while a tool is still running, and says why', () => {
    writeStatusline(T0);
    const p = makePipeline();
    appendEvents(preTool(T0, 'evt-1', 'WebFetch', 'web-fetch'));
    p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    const before = fs.statSync(files.toolEvents).size;
    fs.appendFileSync(files.toolEvents, 'x'.repeat(1024 * 1024));
    logs.length = 0;
    p.tick({ nowMs: T0 + 6000, currentTmuxClaudePid: PID });

    assert.ok(fs.statSync(files.toolEvents).size > before, 'not rotated — correct, an event may still be mid-flight');
    assert.ok(logs.some((l) => /rotation/i.test(l) && /active_tools|running/i.test(l)),
      'a log that is over the rotation size and staying there must not be silent');
  });

  it('does not nag about a declined rotation on every single tick', () => {
    writeStatusline(T0);
    const p = makePipeline();
    appendEvents(preTool(T0, 'evt-1', 'WebFetch', 'web-fetch'));
    p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });
    fs.appendFileSync(files.toolEvents, 'x'.repeat(1024 * 1024));
    logs.length = 0;

    for (let i = 0; i < 20; i++) p.tick({ nowMs: T0 + 6000 + i * 15_000, currentTmuxClaudePid: PID });
    const nags = logs.filter((l) => /rotation/i.test(l));
    assert.ok(nags.length >= 1 && nags.length < 20, `expected a few, got ${nags.length}`);
  });
});

describe('ToolPipeline — restart and reset', () => {
  it('picks up where it left off instead of replaying the whole log', () => {
    writeStatusline(T0);
    const first = makePipeline();
    appendEvents(preTool(T0, 'evt-1'), postTool(T0 + 100, 'evt-1'));
    first.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    const second = makePipeline();
    assert.ok(second.streamState.offset > 0, 'a restart that forgets the offset re-reads the entire log');
  });

  it('clearFiles wipes the derived state a recovering guardian must not trust', () => {
    writeStatusline(T0);
    const p = makePipeline();
    appendEvents(preTool(T0, 'evt-1'));
    p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    p.reset({ clearFiles: true });
    assert.equal(fs.readFileSync(files.toolEvents, 'utf8'), '');
    assert.equal(fs.existsSync(files.sessionToolState), false);
    assert.equal(Object.keys(p.lifecycleState.sessions).length, 0);
  });

  it('starts clean when the persisted session state is unreadable', () => {
    writeStatusline(T0);
    const p = makePipeline();
    appendEvents(preTool(T0, 'evt-1'), postTool(T0 + 100, 'evt-1'));
    p.tick({ nowMs: T0 + 3000, currentTmuxClaudePid: PID });

    fs.writeFileSync(files.sessionToolState, '{ half written');
    const revived = makePipeline();
    assert.equal(Object.keys(revived.lifecycleState.sessions).length, 0);
  });
});

describe('canTreatPaneAsRecovered', () => {
  const base = { captureOk: true, promptVisible: true, usageOverlay: false, inProgressCapture: false, inputState: 'empty' };

  it('accepts a clean prompt', () => {
    assert.equal(canTreatPaneAsRecovered(base), true);
    assert.equal(canTreatPaneAsRecovered({ ...base, inputState: 'has_content' }), true);
  });

  for (const [label, patch] of [
    ['the capture failed', { captureOk: false }],
    ['no prompt is visible', { promptVisible: false }],
    ['a usage overlay is up', { usageOverlay: true }],
    ['work is still in progress', { inProgressCapture: true }],
    ['the input state is unknown', { inputState: 'unknown' }],
  ]) {
    it(`refuses when ${label}`, () => {
      assert.equal(canTreatPaneAsRecovered({ ...base, ...patch }), false);
    });
  }

  it('refuses a missing reading outright', () => {
    assert.equal(canTreatPaneAsRecovered(null), false);
    assert.equal(canTreatPaneAsRecovered(undefined), false);
  });
});

/**
 * TD-271 discipline: a field nobody reads is not a fix. `activity_known` is
 * published by the pipeline above; these prove something downstream acts on it
 * and that a human can see it.
 */
describe('activity_known is actually consumed', () => {
  it('summarizeApiActivity refuses to confirm activity it cannot vouch for', async () => {
    const { MonitorOrchestrator } = await import('../monitor-orchestrator.js');
    const orchestrator = Object.create(MonitorOrchestrator.prototype);
    const currentTime = Math.floor(T0 / 1000);

    const observed = orchestrator.summarizeApiActivity({
      currentTime,
      apiActivity: { activity_known: true, active_tools: 2, active: true, updated_at: T0 },
    });
    assert.equal(observed.confirmedActive, true);
    assert.equal(observed.activityKnown, true);

    const guessed = orchestrator.summarizeApiActivity({
      currentTime,
      apiActivity: { activity_known: false, active_tools: 2, active: true, updated_at: T0 },
    });
    assert.equal(guessed.confirmedActive, false,
      'the freeze detector treats confirmedActive as ground truth; a guess must not become one');
  });

  it('treats a snapshot from before the field existed as observed', async () => {
    const { MonitorOrchestrator } = await import('../monitor-orchestrator.js');
    const orchestrator = Object.create(MonitorOrchestrator.prototype);
    const legacy = orchestrator.summarizeApiActivity({
      currentTime: Math.floor(T0 / 1000),
      apiActivity: { active_tools: 2, active: true, updated_at: T0 },
    });
    assert.equal(legacy.activityKnown, true);
    assert.equal(legacy.confirmedActive, true, 'an upgrade must not silently disarm freeze detection');
  });

  it('the status file carries it, so a human can see the difference', () => {
    const source = fs.readFileSync(new URL('../monitor.js', import.meta.url), 'utf8');
    assert.match(source, /activity_known: apiActivity\?\.activity_known !== false/,
      'agent-status.json is where an operator looks when a machine "went quiet"');
  });
});
