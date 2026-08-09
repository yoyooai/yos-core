/**
 * The unit above tests the part. This file tests that the part is actually
 * bolted on — the exact gap that made 0.1.12's first "fixed" claim wrong
 * (a logger was welded into the class nobody called).
 *
 * Two things must hold, mechanically:
 *   1. `yos uninstall --self` really calls the reclaim, with ~/yos as the
 *      receipt, and before the steps that could destroy the evidence.
 *   2. Nobody grows a second implementation of the ~/.claude.json approval
 *      write — that duplicate was TD-115, and it drifted in silence for weeks.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const CLI_DIR = path.join(import.meta.dirname, '..', '..');
const uninstallSource = fs.readFileSync(path.join(CLI_DIR, 'commands', 'self-uninstall.js'), 'utf8');

describe('self-uninstall is wired to the reclaim', () => {
  it('imports it from the module that owns the credential files', () => {
    assert.match(
      uninstallSource,
      /import \{ reclaimClaudeCredentials \} from '\.\.\/lib\/claude-credentials\.js'/,
    );
  });

  it('calls it, handing over the YOS dir that holds the receipt', () => {
    assert.match(uninstallSource, /reclaimClaudeCredentials\(\{\s*yosDir:\s*YOS_DIR\s*\}\)/);
  });

  it('⭐ runs it before ~/yos/ can be deleted — otherwise the receipt is gone', () => {
    const reclaimAt = uninstallSource.indexOf('reclaimClaudeCredentials({');
    const removeDataAt = uninstallSource.indexOf('removeDirectory(YOS_DIR)');
    assert.ok(reclaimAt > 0 && removeDataAt > 0);
    assert.ok(
      reclaimAt < removeDataAt,
      'reclaim must run while ~/yos/.env still exists, or every key looks unprovable and is kept',
    );
  });

  it('⭐ runs it before the optional "remove Claude CLI" step', () => {
    // That step deletes ~/.claude wholesale; running after it would make the
    // reclaim report "nothing of ours" on exactly the path that needed it.
    const reclaimAt = uninstallSource.indexOf('reclaimClaudeCredentials({');
    const removeClaudeAt = uninstallSource.indexOf('uninstallClaudeCli()');
    assert.ok(removeClaudeAt > 0);
    assert.ok(reclaimAt < removeClaudeAt);
  });

  it('says what it left behind, not only what it removed', () => {
    // Silence about a key we chose not to delete is how the customer ends up
    // not knowing it is still there.
    const report = uninstallSource.slice(uninstallSource.indexOf('function reportCredentialReclaim'));
    assert.match(report, /result\.kept/);
    assert.match(report, /reason/);
  });

  it('promises it up front, in the summary the customer reads first', () => {
    const summary = uninstallSource.slice(
      uninstallSource.indexOf("console.log(bold('This will:'))"),
      uninstallSource.indexOf('Confirmation'),
    );
    assert.match(summary, /settings\.json/);
  });
});

describe('⭐ only one implementation writes the Claude approval', () => {
  function collectJsFiles(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collectJsFiles(full, acc);
      else if (entry.name.endsWith('.js')) acc.push(full);
    }
    return acc;
  }

  it('no file outside claude-credentials.js writes customApiKeyResponses', () => {
    const offenders = collectJsFiles(CLI_DIR)
      .filter((file) => path.basename(file) !== 'claude-credentials.js')
      .filter((file) => /customApiKeyResponses/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(CLI_DIR, file));

    assert.deepEqual(
      offenders,
      [],
      `these files grew their own copy of the approval write: ${offenders.join(', ')} — call approveCustomApiKey instead`,
    );
  });

  it('the Claude adapter uses the shared one', () => {
    const adapter = fs.readFileSync(path.join(CLI_DIR, 'lib', 'runtime', 'claude.js'), 'utf8');
    assert.match(adapter, /import \{ approveCustomApiKey \} from '\.\.\/claude-credentials\.js'/);
    assert.match(adapter, /approveCustomApiKey\(apiKeyValue\)/);
    assert.match(adapter, /approveCustomApiKey\(oauthTokenValue\)/);
  });

  it('runtime-setup keeps its onboarding extras but delegates the approval', () => {
    const setup = fs.readFileSync(path.join(CLI_DIR, 'lib', 'runtime-setup.js'), 'utf8');
    const fn = setup.slice(setup.indexOf('export function approveApiKey'), setup.indexOf('export function saveApiKey'));
    assert.match(fn, /approveCustomApiKey\(keyOrToken\)/);
    assert.ok(!/approved\.push/.test(fn), 'runtime-setup must not push approvals itself any more');
  });
});
