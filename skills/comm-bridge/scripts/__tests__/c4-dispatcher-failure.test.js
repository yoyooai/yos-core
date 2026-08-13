import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-dispatcher-failure-'));
const original = {
  YOS_DIR: process.env.YOS_DIR,
  C4_DISPATCHER_DISABLE_MAIN: process.env.C4_DISPATCHER_DISABLE_MAIN
};
process.env.YOS_DIR = tmpDir;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';

const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const db = await import(new URL(`../c4-db.js?${cacheBuster}`, import.meta.url));
const dispatcher = await import(new URL(`../c4-dispatcher.js?${cacheBuster}`, import.meta.url));

after(() => {
  db.close();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('conversation delivery exhaustion', () => {
  it('alerts independently when the agent stays offline with queued messages', async () => {
    const alerts = [];
    const first = await dispatcher.maybeAlertAdministratorOfAgentDown({
      agentState: 'offline',
      consecutiveChecks: 30,
      pendingCount: 3,
      lastAlertAtMs: 0,
      nowMs: 1_000_000,
      notifyAdmin: async (payload) => { alerts.push(payload); }
    });

    assert.equal(alerts.length, 1);
    assert.deepEqual(alerts[0], {
      agentState: 'offline',
      consecutiveChecks: 30,
      pendingCount: 3
    });
    assert.equal(first.alerted, true);
    assert.equal(first.attempted, true);
    assert.equal(first.lastAlertAtMs, 1_000_000);

    await dispatcher.maybeAlertAdministratorOfAgentDown({
      agentState: 'offline',
      consecutiveChecks: 31,
      pendingCount: 3,
      lastAlertAtMs: first.lastAlertAtMs,
      nowMs: 1_000_001,
      notifyAdmin: async (payload) => { alerts.push(payload); }
    });
    assert.equal(alerts.length, 1, 'cooldown must prevent alert floods');

    await dispatcher.maybeAlertAdministratorOfAgentDown({
      agentState: 'offline',
      consecutiveChecks: 31,
      pendingCount: 3,
      lastAlertAtMs: 0,
      nowMs: 2_000_000,
      notifyAdmin: async (payload) => { alerts.push(payload); }
    });
    assert.equal(alerts.length, 2, 'checks beyond the threshold must still alert');
  });

  it('does not alert for an empty queue or a live agent', async () => {
    let calls = 0;
    const notifyAdmin = async () => { calls += 1; };
    await dispatcher.maybeAlertAdministratorOfAgentDown({
      agentState: 'offline', consecutiveChecks: 30, pendingCount: 0,
      lastAlertAtMs: 0, nowMs: 1_000_000, notifyAdmin
    });
    await dispatcher.maybeAlertAdministratorOfAgentDown({
      agentState: 'idle', consecutiveChecks: 30, pendingCount: 2,
      lastAlertAtMs: 0, nowMs: 1_000_000, notifyAdmin
    });
    assert.equal(calls, 0);
  });

  it('the live dispatcher loop checks queued messages through the independent alert', () => {
    const source = fs.readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8');
    const liveLoop = source.match(/async function processNextMessage\(\) \{([\s\S]*?)const item = claimNextItem\(\);/);
    assert.ok(liveLoop, 'processNextMessage must remain inspectable before claiming work');
    assert.match(liveLoop[1], /maybeAlertAdministratorOfAgentDown\(\{/);
    assert.match(liveLoop[1], /const pendingCount = getPendingCount\(\);/);
    assert.match(liveLoop[1], /maybeAlertAdministratorOfAgentDown\(\{[\s\S]*?\bpendingCount,/);
  });

  it('arms the alert cooldown after an attempt rather than only after delivery', () => {
    const source = fs.readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8');
    const liveLoop = source.match(/async function processNextMessage\(\) \{([\s\S]*?)const item = claimNextItem\(\);/);
    assert.ok(liveLoop, 'processNextMessage must remain inspectable before claiming work');
    const cooldownGuard = liveLoop[1].match(/if \(alert\.attempted\) \{([\s\S]*?)\n\s*\}/);
    assert.ok(cooldownGuard, 'an attempted alert must arm the cooldown');
    assert.match(cooldownGuard[1], /lastAgentDownAlertAtMs = alert\.lastAlertAtMs;/);
    assert.doesNotMatch(liveLoop[1], /if \(alert\.alerted\) \{[\s\S]*?lastAgentDownAlertAtMs/);
  });

  it('records one local threshold warning even when no message is queued', () => {
    assert.equal(dispatcher.shouldLogAgentDownThreshold(29), false);
    assert.equal(dispatcher.shouldLogAgentDownThreshold(30), true);
    assert.equal(dispatcher.shouldLogAgentDownThreshold(31), false);

    const source = fs.readFileSync(new URL('../c4-dispatcher.js', import.meta.url), 'utf8');
    const liveLoop = source.match(/async function processNextMessage\(\) \{([\s\S]*?)const item = claimNextItem\(\);/);
    assert.ok(liveLoop, 'processNextMessage must remain inspectable before claiming work');
    const warningGuard = liveLoop[1].match(/if \(shouldLogAgentDownThreshold\(tmuxMissingChecks\)\) \{([\s\S]*?)\n\s*\}/);
    assert.ok(warningGuard, 'the local threshold warning must have its own guard');
    assert.match(warningGuard[1], /pending=\$\{pendingCount\}/);
    assert.doesNotMatch(warningGuard[0], /alert\.(?:alerted|attempted)/);
  });

  it('does not claim an alert was sent when the administrator target is not configured', async () => {
    const result = await dispatcher.maybeAlertAdministratorOfAgentDown({
      agentState: 'offline',
      consecutiveChecks: 30,
      pendingCount: 2,
      lastAlertAtMs: 0,
      nowMs: 1_000_000,
      notifyAdmin: async () => ({ sent: false, reason: 'not_configured' })
    });

    assert.deepEqual(result, {
      alerted: false,
      attempted: true,
      lastAlertAtMs: 1_000_000,
      reason: 'not_configured'
    });
  });

  it('keeps the dispatcher alive when the independent alert transport fails', async () => {
    const result = await dispatcher.maybeAlertAdministratorOfAgentDown({
      agentState: 'stopped',
      consecutiveChecks: 30,
      pendingCount: 2,
      lastAlertAtMs: 0,
      nowMs: 1_000_000,
      notifyAdmin: async () => { throw new Error('channel unavailable'); }
    });

    assert.equal(result.alerted, false);
    assert.equal(result.attempted, true);
    assert.equal(result.lastAlertAtMs, 1_000_000, 'failed alerts still enter cooldown');
  });

  it('marks the message failed and alerts the administrator without user content', async () => {
    const record = db.insertConversation(
      'in',
      'lark',
      'chat-1',
      'customer secret body',
      'pending',
      3,
      false,
      null,
      'om_1'
    );
    assert.equal(db.claimConversation(record.id), true);
    db.incrementRetryCount(record.id);

    let alert = null;
    await dispatcher.handleConversationDeliveryFailure(
      { ...record, retry_count: 1 },
      {
        channelHealthy: true,
        notifyAdmin: async (payload) => { alert = payload; },
        wait: async () => {}
      }
    );

    const row = db.getDb().prepare('SELECT status, retry_count FROM conversations WHERE id = ?').get(record.id);
    assert.deepEqual(row, { status: 'failed', retry_count: 2 });
    assert.equal(alert.conversationId, record.id);
    assert.equal(alert.channel, 'lark');
    assert.equal(alert.endpoint, 'chat-1');
    assert.equal(alert.retryCount, 2);
    assert.equal('content' in alert, false);
  });

  it('builds a content-free administrator alert', () => {
    const message = dispatcher.buildDeliveryFailureAlert({
      conversationId: 42,
      channel: 'wechat',
      endpoint: 'user-7',
      retryCount: 2
    });

    assert.match(message, /42/);
    assert.match(message, /wechat/);
    assert.match(message, /user-7/);
    assert.match(message, /2/);
    assert.doesNotMatch(message, /customer secret body/);
  });

  it('builds a content-free agent-down alert', () => {
    const message = dispatcher.buildAgentDownAlert({
      agentState: 'offline',
      consecutiveChecks: 30,
      pendingCount: 4
    });
    assert.match(message, /offline/);
    assert.match(message, /30/);
    assert.match(message, /4/);
    assert.doesNotMatch(message, /customer secret body/);
  });

  it('requires an explicit administrator target', () => {
    let called = false;
    const result = dispatcher.notifyAdministratorOfDeliveryFailure(
      { conversationId: 42, channel: 'wechat', endpoint: 'user-7', retryCount: 2 },
      {
        env: {},
        runSend: () => {
          called = true;
          return { status: 0 };
        }
      }
    );

    assert.deepEqual(result, { sent: false, reason: 'not_configured' });
    assert.equal(called, false);
  });

  it('sends metadata-only alerts to the configured administrator', () => {
    let invocation = null;
    const result = dispatcher.notifyAdministratorOfDeliveryFailure(
      { conversationId: 42, channel: 'wechat', endpoint: 'user-7', retryCount: 2 },
      {
        env: { YOS_ADMIN_CHANNEL: 'lark', YOS_ADMIN_ENDPOINT: 'owner-chat' },
        runSend: (command, args, options) => {
          invocation = { command, args, options };
          return { status: 0, stdout: '', stderr: '' };
        }
      }
    );

    assert.deepEqual(result, { sent: true });
    assert.equal(invocation.command, 'node');
    assert.deepEqual(invocation.args.slice(-2), ['lark', 'owner-chat']);
    assert.match(invocation.options.input, /Conversation ID: 42/);
    assert.doesNotMatch(invocation.options.input, /customer secret body/);
  });
});
