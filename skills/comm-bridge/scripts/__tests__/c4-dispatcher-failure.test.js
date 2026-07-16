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
