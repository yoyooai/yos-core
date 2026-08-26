import { describe, it, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Fake filesystem ──────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yos-launch-test-'));
const fakeHome = path.join(tmpRoot, 'home');
const fakeYOSDir = path.join(fakeHome, 'yos');

const savedEnv = {
  HOME: process.env.HOME,
  YOS_DIR: process.env.YOS_DIR,
  CLAUDE_BIN: process.env.CLAUDE_BIN,
  CODEX_BIN: process.env.CODEX_BIN,
  CLAUDE_BYPASS_PERMISSIONS: process.env.CLAUDE_BYPASS_PERMISSIONS,
  CODEX_BYPASS_PERMISSIONS: process.env.CODEX_BYPASS_PERMISSIONS,
};

process.env.HOME = fakeHome;
process.env.YOS_DIR = fakeYOSDir;
process.env.CLAUDE_BIN = 'claude';
process.env.CODEX_BIN = 'codex';
process.env.CLAUDE_BYPASS_PERMISSIONS = 'false';
process.env.CODEX_BYPASS_PERMISSIONS = 'false';

// Directory structure
for (const dir of [
  path.join(fakeHome, '.claude'),
  path.join(fakeYOSDir, '.claude', 'skills', 'comm-bridge', 'scripts'),
  path.join(fakeYOSDir, '.claude', 'skills', 'yos-memory', 'scripts'),
  path.join(fakeYOSDir, '.claude', 'skills', 'activity-monitor', 'scripts'),
  path.join(fakeYOSDir, 'memory'),
  path.join(fakeYOSDir, 'activity-monitor'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(path.join(fakeYOSDir, '.env'), [
  'ANTHROPIC_API_KEY=test-only-not-a-secret',
].join('\n'));

fs.writeFileSync(path.join(fakeYOSDir, 'memory', 'state.md'), '- Status: completed\n');

const { activateFreshSplitInstructions, instructionPaths } = await import('../runtime/instruction-builder.js');
activateFreshSplitInstructions({
  yosDir: fakeYOSDir,
  templatesDir: path.resolve('templates'),
});

for (const script of [
  '.claude/skills/yos-memory/scripts/session-start-inject.js',
  '.claude/skills/comm-bridge/scripts/c4-session-init.js',
  '.claude/skills/activity-monitor/scripts/session-start-prompt.js',
]) {
  fs.writeFileSync(path.join(fakeYOSDir, script), '// stub');
}

// ── Mock child_process ───────────────────────────────────────────────────────

const calls = { execSync: [], execFileSync: [] };
let tmuxSessionExists = false;

mock.module('node:child_process', {
  namedExports: {
    execSync: mock.fn((cmd, opts) => {
      calls.execSync.push({ cmd, opts });
      if (typeof cmd === 'string' && cmd.includes('tmux has-session')) {
        if (!tmuxSessionExists) throw new Error('no session');
      }
      return '';
    }),
    execFileSync: mock.fn((file, args, opts) => {
      calls.execFileSync.push({ file, args: args ? [...args] : [], opts });
      if (file === 'tmux' && args?.[0] === 'has-session') {
        if (!tmuxSessionExists) throw new Error('no session');
        return '';
      }
      if (args?.[0] === '--version') return '2.1.137';
      if (args?.includes('auth')) throw new Error('not logged in');
      return '';
    }),
    spawnSync: mock.fn((file, args, opts) => {
      const yosDir = opts?.env?.YOS_CODEX_TRUST_CWD || fakeYOSDir;
      const key = `${path.join(yosDir, '.codex', 'hooks.json')}:session_start:0:0`;
      const configPath = path.join(fakeHome, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, [
        '[features]',
        'hooks = true',
        '',
        `[hooks.state."${key}"]`,
        'enabled = true',
        'trusted_hash = "sha256:test"',
        '',
      ].join('\n'));
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, trusted: 1 }) + '\n',
        stderr: '',
      };
    }),
    execFile: mock.fn((...fnArgs) => {
      const cb = fnArgs.find(a => typeof a === 'function');
      if (cb) process.nextTick(() => cb(null, '', ''));
      return { on: () => {}, stdout: null, stderr: null, pid: 0 };
    }),
  },
});

// ── Import adapters after mocks ──────────────────────────────────────────────

const { ClaudeAdapter } = await import('../runtime/claude.js');
const { CodexAdapter } = await import('../runtime/codex.js');

// ── Cleanup ──────────────────────────────────────────────────────────────────

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  calls.execSync.length = 0;
  calls.execFileSync.length = 0;
  tmuxSessionExists = false;
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function findTmuxNewSession() {
  return calls.execFileSync.find(
    c => c.file === 'tmux' && c.args?.includes('new-session')
  );
}

function makeAdapter(Cls) {
  const adapter = new Cls({});
  adapter.buildInstructionFile = async () => '/fake/instruction.md';
  return adapter;
}

function readSpecEnv() {
  const tmux = findTmuxNewSession();
  if (!tmux) return null;
  const lastArg = tmux.args[tmux.args.length - 1];
  const specMatch = lastArg.match(/"([^"]+\.json)"/);
  if (!specMatch) return null;
  try {
    const spec = JSON.parse(fs.readFileSync(specMatch[1], 'utf8'));
    return spec.env;
  } catch {
    return null;
  }
}

function readLaunchSpec() {
  const tmux = findTmuxNewSession();
  if (!tmux) return null;
  const lastArg = tmux.args[tmux.args.length - 1];
  const specMatch = lastArg.match(/"([^"]+\.json)"/);
  if (!specMatch) return null;
  try {
    return JSON.parse(fs.readFileSync(specMatch[1], 'utf8'));
  } catch {
    return null;
  }
}

// ── Claude launch tests ──────────────────────────────────────────────────────

describe('Claude launch — new session', () => {
  it('tmux new-session includes -E flag', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux, 'should call execFileSync with tmux new-session');
    assert.ok(tmux.args.includes('-E'), 'tmux args must include -E');
  });

  it('tmux shell-command uses absolute node path from process.execPath', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const shellCmd = tmux.args[tmux.args.length - 1];
    assert.ok(
      shellCmd.includes(process.execPath),
      `tmux shell-command must use absolute node path (process.execPath=${process.execPath}), got: ${shellCmd}`,
    );
  });

  it('tmux cmdline does not contain API key or ANTHROPIC_API_KEY', async () => {
    tmuxSessionExists = false;
    await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const joined = tmux.args.join(' ');
    assert.ok(!joined.includes('test-only-not-a-secret'), 'tmux cmdline must not contain API key value');
    assert.ok(!joined.includes('ANTHROPIC_API_KEY'), 'tmux cmdline must not expose ANTHROPIC_API_KEY');
  });

  it('spec.env excludes CLAUDECODE and CLAUDE_CODE_ENTRYPOINT even when present in process.env', async () => {
    tmuxSessionExists = false;
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.CLAUDECODE, undefined, 'CLAUDECODE must be stripped from spec.env');
      assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined, 'CLAUDE_CODE_ENTRYPOINT must be stripped from spec.env');
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });

  it('spec.env excludes auth tokens when native auth is detected', async () => {
    tmuxSessionExists = false;
    // Simulate native auth by writing a credentials file
    const credFile = path.join(fakeHome, '.claude', '.credentials.json');
    fs.writeFileSync(credFile, JSON.stringify({
      claudeAiOauth: { refreshToken: 'fake-refresh-token' },
    }));
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must be stripped when native auth detected');
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'CLAUDE_CODE_OAUTH_TOKEN must be stripped when native auth detected');
    } finally {
      fs.unlinkSync(credFile);
    }
  });
});

describe('Claude launch — existing session', () => {
  it('does not create a new tmux session', async () => {
    tmuxSessionExists = true;
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.sendMessage = async () => {};

    await adapter.launch({ bypassPermissions: false });

    assert.equal(findTmuxNewSession(), undefined, 'must NOT call tmux new-session');
  });

  it('sends command via sendMessage', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(ClaudeAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.length > 0, 'sendMessage should be called');
    assert.ok(sent.includes('claude'), 'sent command should reference claude');
  });
});

describe('Claude launch — compat mode PATH dedupe', () => {
  it('spec.env.PATH is deduplicated in compat mode', async () => {
    tmuxSessionExists = false;
    // Switch to compat mode
    fs.writeFileSync(path.join(fakeYOSDir, '.env'), [
      'ANTHROPIC_API_KEY=test-only-not-a-secret',
      'YOS_CLEAN_ENV=false',
    ].join('\n'));
    // Inject a bloated PATH
    const origPath = process.env.PATH;
    process.env.PATH = '/a:/b:/a:/c:/b';
    try {
      await makeAdapter(ClaudeAdapter).launch({ bypassPermissions: false });
      const env = readSpecEnv();
      assert.ok(env, 'spec should be written');
      assert.equal(env.PATH, '/a:/b:/c', 'PATH must be deduplicated in compat mode');

      const tmux = findTmuxNewSession();
      const pathArg = tmux.args.find(a => a.startsWith('PATH='));
      assert.ok(pathArg, 'tmux args should contain PATH= env');
      assert.equal(pathArg, 'PATH=/a:/b:/c', 'tmux -e PATH must also be deduplicated');
    } finally {
      process.env.PATH = origPath;
      // Restore default (clean env is now the default)
      fs.writeFileSync(path.join(fakeYOSDir, '.env'), [
        'ANTHROPIC_API_KEY=test-only-not-a-secret',
      ].join('\n'));
    }
  });
});

// ── Codex launch tests ───────────────────────────────────────────────────────

describe('Codex launch — new session', () => {
  it('refuses to launch when the current instruction marker is missing', async () => {
    const markerPath = instructionPaths('codex', { yosDir: fakeYOSDir }).markerPath;
    const marker = fs.readFileSync(markerPath);
    fs.unlinkSync(markerPath);
    try {
      await assert.rejects(
        () => makeAdapter(CodexAdapter).launch({ bypassPermissions: false }),
        /unsupported instruction layout/i,
      );
    } finally {
      fs.writeFileSync(markerPath, marker);
    }
  });

  it('tmux new-session includes -E flag', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux, 'should call execFileSync with tmux new-session');
    assert.ok(tmux.args.includes('-E'), 'tmux args must include -E');
  });

  it('tmux shell-command uses absolute node path from process.execPath', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const shellCmd = tmux.args[tmux.args.length - 1];
    assert.ok(
      shellCmd.includes(process.execPath),
      `tmux shell-command must use absolute node path (process.execPath=${process.execPath}), got: ${shellCmd}`,
    );
  });

  it('tmux cmdline does not contain secrets', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const tmux = findTmuxNewSession();
    assert.ok(tmux);
    const joined = tmux.args.join(' ');
    assert.ok(!joined.includes('test-only-not-a-secret'), 'tmux cmdline must not contain API key value');
  });

  it('launch spec does not contain the retired text bootstrap prompt', async () => {
    tmuxSessionExists = false;
    await makeAdapter(CodexAdapter).launch({ bypassPermissions: false });

    const spec = readLaunchSpec();
    assert.ok(spec, 'spec should be written');
    // Since #681 the only launch arg is the kick prompt that triggers the
    // SessionStart hook — never the retired text bootstrap payload. That
    // prompt is a stateless internal lifecycle sentinel, never a human-looking
    // greeting an agent could answer as if a person had spoken.
    assert.equal(spec.args.length, 1);
    // Exact-string lock, not a prefix: a mutated sentence must fail here too.
    assert.equal(spec.args[0],
      'System startup trigger, not a user message. Continue with startup context.');
    assert.doesNotMatch(spec.args[0], /\bhello\b/i);
    assert.doesNotMatch(spec.args[0], /welcome back/i);
    assert.ok(!JSON.stringify(spec).includes('session-start-inject.js'));
  });
});

describe('Codex launch — existing session', () => {
  it('does not create a new tmux session', async () => {
    tmuxSessionExists = true;
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async () => {};

    await adapter.launch({ bypassPermissions: false });

    assert.equal(findTmuxNewSession(), undefined, 'must NOT call tmux new-session');
  });

  it('does not inject a bootstrap prompt in sendMessage', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    assert.ok(sent.length > 0, 'sendMessage should be called');
    assert.ok(sent.includes('codex'), 'sent command should reference codex');
    assert.ok(!sent.includes('_p=$(cat'), 'existing-session command should not load bootstrap prompt');
    assert.ok(!sent.includes('session-start-inject.js'), 'existing-session command should not run text bootstrap');
  });

  it('kicks the restarted session with the sentinel, quoted safely', async () => {
    tmuxSessionExists = true;
    let sent = '';
    const adapter = makeAdapter(CodexAdapter);
    adapter.sendMessage = async (text) => { sent = text; };

    await adapter.launch({ bypassPermissions: false });

    // This branch interpolates the prompt into a double-quoted shell string,
    // so it is the one that breaks if the sentinel ever grows a quote or a
    // dollar sign — assert the rendered command, not just the constant.
    assert.ok(
      sent.includes('"System startup trigger, not a user message. Continue with startup context."'),
      `restart command should carry the quoted sentinel, got: ${sent}`
    );
    assert.doesNotMatch(sent, /codex[^\n]*"hello"/i);
  });
});
