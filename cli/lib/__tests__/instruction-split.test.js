import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  activateFreshSplitInstructions,
  assertInstructionReady,
  buildInstructionFile,
  CURRENT_INSTRUCTION_FORMAT_VERSION,
  deployInstructionAssets,
  instructionFormatVersionPath,
  instructionPaths,
  needsRebuild,
  readInstructionFormatVersion,
  refreshSplitInstructions,
  writeInstructionFormatVersion,
} from '../runtime/instruction-builder.js';
import {
  assembleInstruction,
  needsRebuild as leafNeedsRebuild,
} from '../runtime/assembler.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'templates');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yos-split-test-'));
}

function leftovers(root) {
  const found = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else if (entry.name.includes('.split-txn.') || entry.name.includes('.split-render.')) found.push(filePath);
    }
  }
  walk(root);
  return found;
}

describe('instruction format version protocol', () => {
  it('distinguishes missing, valid and invalid values and round-trips atomically', () => {
    const root = fixture();
    assert.deepEqual(
      readInstructionFormatVersion({ yosDir: root }),
      { version: null, valid: true, exists: false, filePath: instructionFormatVersionPath({ yosDir: root }) },
    );
    for (const version of [1, 2, 3]) {
      writeInstructionFormatVersion({ yosDir: root, version });
      assert.equal(fs.readFileSync(instructionFormatVersionPath({ yosDir: root }), 'utf8'), `${version}\n`);
      assert.equal(readInstructionFormatVersion({ yosDir: root }).version, version);
    }
    for (const invalid of ['', '0\n', '-1\n', '2.5\n', ' 2\n', `${Number.MAX_SAFE_INTEGER}0\n`, 'wat\n']) {
      fs.writeFileSync(instructionFormatVersionPath({ yosDir: root }), invalid);
      const state = readInstructionFormatVersion({ yosDir: root });
      assert.equal(state.valid, false);
      assert.equal(state.version, null);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cleans the temp file when the atomic rename fails', () => {
    const root = fixture();
    assert.throws(() => writeInstructionFormatVersion({
      yosDir: root,
      io: { renameSync() { throw new Error('rename fault'); } },
    }), /rename fault/);
    assert.equal(fs.existsSync(instructionFormatVersionPath({ yosDir: root })), false);
    assert.deepEqual(fs.readdirSync(path.join(root, '.yos')), []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('split instruction assembler', () => {
  it('rejects an unmarked instruction layout instead of entering migration mode', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'YOS.md'), 'unsupported layout\n');
    assert.throws(
      () => refreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR }),
      /unsupported instruction layout/i,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('pins the system templates to the approved content-redraft bytes', () => {
    // Reintroduction guard: any template edit must consciously update these
    // pins alongside the reviewed content change (issue #722 content redraft).
    const managedHeader = '> **YOS-managed system instructions.** This file is replaced during upgrades. Put all custom instructions in `~/yos/YOS.md`.\n\n';
    const expected = {
      claude: 'f77e283d3e82b7dfd5be141a6be68234c387955da20ad04a8fef93326af2a9c2',
      codex: '8bcfbf4ef2b363778879c5b6bb9e94c4def5537b0e237ca78deebfe380b11e05',
    };
    for (const runtime of ['claude', 'codex']) {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, `${runtime}-system.md`), 'utf8');
      assert.ok(content.startsWith(managedHeader));
      assert.equal(crypto.createHash('sha256').update(content.slice(managedHeader.length)).digest('hex'), expected[runtime]);
    }
  });

  it('guards the canonical assembler API against ephemeral instruction seams', () => {
    const assemblerSource = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'lib', 'runtime', 'assembler.mjs'), 'utf8');
    const builderSource = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'lib', 'runtime', 'instruction-builder.js'), 'utf8');
    assert.doesNotMatch(assemblerSource, /memorySnapshot|ephemeral/);
    assert.doesNotMatch(builderSource, /memorySnapshot|claude-addon|codex-addon|syncClaudeMd/);
  });

  it('writes source header and rebuilds only when an input is newer', () => {
    const root = fixture();
    const systemPath = path.join(root, 'system.md');
    const userPath = path.join(root, 'user.md');
    const outputPath = path.join(root, 'output.md');
    fs.writeFileSync(systemPath, 'SYSTEM\n');
    fs.writeFileSync(userPath, 'USER\n');
    assert.equal(leafNeedsRebuild({ systemPath, userPath, outputPath }), true);
    assembleInstruction({ systemPath, userPath, outputPath });
    const output = fs.readFileSync(outputPath, 'utf8');
    assert.match(output, /yos-generated:split-v1/);
    assert.match(output, new RegExp(`system: ${systemPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(output, /SYSTEM\n\nUSER/);
    assert.equal(leafNeedsRebuild({ systemPath, userPath, outputPath }), false);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(userPath, future, future);
    assert.equal(leafNeedsRebuild({ systemPath, userPath, outputPath }), true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('materializes onboarding.md on activation and refresh', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const onboardingPath = instructionPaths('claude', { yosDir: root }).onboardingPath;
    const template = fs.readFileSync(path.join(TEMPLATES_DIR, 'onboarding.md'), 'utf8');
    assert.equal(fs.readFileSync(onboardingPath, 'utf8'), template);
    fs.writeFileSync(onboardingPath, 'stale local copy\n');
    refreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(fs.readFileSync(onboardingPath, 'utf8'), template);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves existing asset modes while leaving new asset defaults unchanged', () => {
    const root = fixture();
    const paths = instructionPaths('claude', { yosDir: root });
    fs.mkdirSync(paths.instructionsDir, { recursive: true });
    fs.writeFileSync(paths.systemPath, 'old system\n');
    fs.chmodSync(paths.systemPath, 0o600);
    deployInstructionAssets({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(fs.statSync(paths.systemPath).mode & 0o777, 0o600);
    assert.equal(
      fs.statSync(paths.onboardingPath).mode & 0o777,
      0o666 & ~process.umask(),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fails loudly when runtime instructions do not use the current layout', () => {
    const root = fixture();
    assert.throws(
      () => assertInstructionReady('codex', { yosDir: root }),
      /unsupported instruction layout/i,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('runs from the materialized leaf after package code is unavailable', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('codex', { yosDir: root });
    fs.appendFileSync(paths.userPath, '\nMATERIALIZED_ONLY_SENTINEL\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(paths.userPath, future, future);
    execFileSync(process.execPath, [
      paths.assemblerPath,
      '--marker', paths.markerPath,
      '--system', paths.systemPath,
      '--user', paths.userPath,
      '--output', paths.outputPath,
    ], { cwd: root });
    assert.match(fs.readFileSync(paths.outputPath, 'utf8'), /MATERIALIZED_ONLY_SENTINEL/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects an active launch boundary until the generation is prepared', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const userPath = instructionPaths('codex', { yosDir: root }).userPath;
    fs.appendFileSync(userPath, '\nchanged\n');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(userPath, future, future);
    assert.throws(() => assertInstructionReady('codex', { yosDir: root }), /not prepared before launch/);
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(userPath, past, past);
    buildInstructionFile('codex', { yosDir: root, force: true });
    assert.equal(assertInstructionReady('codex', { yosDir: root }), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('fresh split activation transaction', () => {
  it('commits the marker before writing v2 and treats a version write fault as non-fatal', () => {
    const root = fixture();
    const result = activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.versionWritten, true);
    assert.equal(readInstructionFormatVersion({ yosDir: root }).version, CURRENT_INSTRUCTION_FORMAT_VERSION);
    fs.rmSync(root, { recursive: true, force: true });

    const failedRoot = fixture();
    const failed = activateFreshSplitInstructions({
      yosDir: failedRoot,
      templatesDir: TEMPLATES_DIR,
      versionIo: { writeFileSync() { throw new Error('version fault'); } },
    });
    assert.equal(failed.active, true);
    assert.equal(failed.versionWritten, false);
    assert.match(failed.versionWriteError.message, /version fault/);
    assert.equal(fs.existsSync(instructionPaths('claude', { yosDir: failedRoot }).markerPath), true);
    assert.equal(fs.existsSync(instructionFormatVersionPath({ yosDir: failedRoot })), false);
    assert.equal(fs.readdirSync(path.join(failedRoot, '.yos')).some(name => name.includes('.tmp.')), false);
    fs.rmSync(failedRoot, { recursive: true, force: true });
  });

  it('never attempts the version write before marker commit', () => {
    const root = fixture();
    let versionWrites = 0;
    assert.throws(() => activateFreshSplitInstructions({
      yosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'rename:marker') throw new Error('marker fault'); },
      versionIo: { writeFileSync() { versionWrites++; } },
    }), /marker fault/);
    assert.equal(versionWrites, 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const faultPoints = [
    'stage:claude-system', 'stage:codex-system', 'stage:assembler', 'stage:seed',
    'stage:claude-output', 'stage:codex-output', 'stage:marker',
    'rename:claude-system', 'rename:codex-system', 'rename:assembler', 'rename:seed',
    'rename:claude-output', 'rename:codex-output', 'rename:marker',
  ];

  for (const point of faultPoints) {
    it(`rolls back ${point} and succeeds on retry`, () => {
      const root = fixture();
      assert.throws(() => activateFreshSplitInstructions({
        yosDir: root,
        templatesDir: TEMPLATES_DIR,
        faultInjector(current) { if (current === point) throw new Error(`fault:${point}`); },
      }), new RegExp(`fault:${point}`));
      const paths = instructionPaths('claude', { yosDir: root });
      assert.equal(fs.existsSync(paths.markerPath), false);
      assert.equal(fs.existsSync(paths.outputPath), false);
      assert.equal(fs.existsSync(instructionPaths('codex', { yosDir: root }).outputPath), false);
      assert.deepEqual(leftovers(root), []);
      activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
      assert.equal(fs.existsSync(paths.markerPath), true);
      assert.equal(fs.existsSync(paths.outputPath), true);
      assert.equal(fs.existsSync(instructionPaths('codex', { yosDir: root }).outputPath), true);
      assert.deepEqual(leftovers(root), []);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }

  for (const entryName of ['claude-system', 'codex-system', 'assembler', 'seed', 'claude-output', 'codex-output']) {
    it(`recovers a fresh activation when rollback removal fails at ${entryName}`, () => {
      const root = fixture();
      assert.throws(() => activateFreshSplitInstructions({
        yosDir: root,
        templatesDir: TEMPLATES_DIR,
        faultInjector(point) {
          if (point === 'rename:marker') throw new Error('forward fault');
          if (point === `rollback:remove:${entryName}`) throw new Error(`remove fault:${entryName}`);
        },
      }), /rollback failed after: forward fault/);
      assert.equal(fs.existsSync(instructionPaths('claude', { yosDir: root }).markerPath), false);
      assert.ok(leftovers(root).length > 0);
      const result = activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
      assert.equal(result.active, true);
      assert.deepEqual(leftovers(root), []);
      fs.rmSync(root, { recursive: true, force: true });
    });
  }

  const activeEntryNames = ['claude-system', 'claude-output', 'codex-system', 'codex-output', 'assembler'];
  for (const boundary of ['remove', 'restore']) {
    for (const entryName of activeEntryNames) {
      it(`recovers an active refresh when rollback ${boundary} fails at ${entryName}`, () => {
        const root = fixture();
        activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
        const markerPath = instructionPaths('claude', { yosDir: root }).markerPath;
        const markerBefore = fs.readFileSync(markerPath);
        assert.throws(() => refreshSplitInstructions({
          yosDir: root,
          templatesDir: TEMPLATES_DIR,
          faultInjector(point) {
            if (point === 'rename:marker') throw new Error('forward fault');
            if (point === `rollback:${boundary}:${entryName}`) throw new Error(`${boundary} fault:${entryName}`);
          },
        }), /rollback failed after: forward fault/);
        assert.deepEqual(fs.readFileSync(markerPath), markerBefore);
        const result = refreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
        assert.equal(result.active, true);
        assert.deepEqual(leftovers(root), []);
        fs.rmSync(root, { recursive: true, force: true });
      });
    }
  }

  it('treats cleanup failure as committed and retry converges without residue', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    refreshSplitInstructions({
      yosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) {
        if (point === 'cleanup:backup:claude-system') throw new Error('cleanup fault');
      },
    });
    assert.equal(fs.existsSync(instructionPaths('claude', { yosDir: root }).markerPath), true);
    assert.ok(leftovers(root).some(filePath => filePath.endsWith('.bak')));
    refreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('discards a committed transaction backup without restoring stale assembler bytes', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { yosDir: root });
    const marker = JSON.parse(fs.readFileSync(paths.markerPath, 'utf8'));
    const current = Buffer.from('committed assembler bytes\n');
    fs.writeFileSync(paths.assemblerPath, current);
    fs.writeFileSync(`${paths.assemblerPath}.split-txn.${marker.transactionId}.bak`, 'stale assembler bytes\n');

    assert.throws(() => refreshSplitInstructions({
      yosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'stage:claude-system') throw new Error('stop after recovery'); },
    }), /stop after recovery/);

    assert.deepEqual(fs.readFileSync(paths.assemblerPath), current);
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores an uncommitted transaction backup before starting the next refresh', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { yosDir: root });
    const restored = Buffer.from('restored assembler bytes\n');
    fs.writeFileSync(paths.assemblerPath, 'partial assembler bytes\n');
    fs.writeFileSync(`${paths.assemblerPath}.split-txn.111.222.deadbeef.bak`, restored);

    assert.throws(() => refreshSplitInstructions({
      yosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'stage:claude-system') throw new Error('stop after recovery'); },
    }), /stop after recovery/);

    assert.deepEqual(fs.readFileSync(paths.assemblerPath), restored);
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses fresh activation when unmarked legacy instruction artifacts exist', () => {
    const root = fixture();
    const legacyUser = Buffer.from('## Behavioral Rules\nlegacy system plus user\n');
    const legacyClaude = Buffer.from('legacy claude output\n');
    const legacyAgents = Buffer.from('legacy codex output\n');
    fs.writeFileSync(path.join(root, 'YOS.md'), legacyUser);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), legacyClaude);
    fs.writeFileSync(path.join(root, 'AGENTS.md'), legacyAgents);
    assert.throws(
      () => activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR }),
      /unsupported instruction layout/i,
    );
    assert.equal(fs.existsSync(instructionPaths('claude', { yosDir: root }).markerPath), false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'YOS.md')), legacyUser);
    assert.deepEqual(fs.readFileSync(path.join(root, 'CLAUDE.md')), legacyClaude);
    assert.deepEqual(fs.readFileSync(path.join(root, 'AGENTS.md')), legacyAgents);
    assert.equal(fs.existsSync(instructionPaths('claude', { yosDir: root }).assemblerPath), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recovers a hard-killed active refresh while leaving the live marker in place', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { yosDir: root });
    const markerBefore = fs.readFileSync(paths.markerPath);
    const systemBefore = fs.readFileSync(paths.systemPath);
    const token = '9999.123456.deadbeef';
    fs.renameSync(paths.systemPath, `${paths.systemPath}.split-txn.${token}.bak`);
    fs.writeFileSync(paths.systemPath, 'partially applied generation\n');
    fs.writeFileSync(`${paths.markerPath}.split-txn.${token}`, JSON.stringify({ transactionId: token }));

    assert.deepEqual(fs.readFileSync(paths.markerPath), markerBefore);
    const result = refreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.active, true);
    assert.deepEqual(fs.readFileSync(paths.systemPath), systemBefore);
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('retains a failed rollback backup and recovers it on retry', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { yosDir: root });
    const markerBefore = fs.readFileSync(paths.markerPath);
    let injectedRestoreFailure = false;
    assert.throws(() => refreshSplitInstructions({
      yosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) {
        if (point === 'rename:codex-system') throw new Error('forward fault');
        if (!injectedRestoreFailure && point === 'rollback:restore:claude-system') {
          injectedRestoreFailure = true;
          throw new Error('restore EIO');
        }
      },
    }), /rollback failed after: forward fault/);
    assert.deepEqual(fs.readFileSync(paths.markerPath), markerBefore);
    assert.ok(leftovers(root).some(filePath => filePath.endsWith('.bak')));

    const result = refreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.equal(result.active, true);
    assert.ok(fs.existsSync(paths.systemPath));
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('preserves user content on active re-init and repairs a missing materialized assembler', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const paths = instructionPaths('claude', { yosDir: root });
    const user = Buffer.from('user-owned re-init sentinel\n');
    fs.writeFileSync(paths.userPath, user);
    fs.unlinkSync(paths.assemblerPath);
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.deepEqual(fs.readFileSync(paths.userPath), user);
    assert.ok(fs.existsSync(paths.assemblerPath));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restores the complete active generation when a refresh rename fails', () => {
    const root = fixture();
    activateFreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    const watched = [
      instructionPaths('claude', { yosDir: root }).markerPath,
      instructionPaths('claude', { yosDir: root }).systemPath,
      instructionPaths('codex', { yosDir: root }).systemPath,
      instructionPaths('claude', { yosDir: root }).outputPath,
      instructionPaths('codex', { yosDir: root }).outputPath,
    ];
    const before = watched.map(filePath => fs.readFileSync(filePath));
    assert.throws(() => refreshSplitInstructions({
      yosDir: root,
      templatesDir: TEMPLATES_DIR,
      faultInjector(point) { if (point === 'rename:codex-output') throw new Error('active rename fault'); },
    }), /active rename fault/);
    watched.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), before[index]));
    assert.deepEqual(leftovers(root), []);
    refreshSplitInstructions({ yosDir: root, templatesDir: TEMPLATES_DIR });
    assert.deepEqual(leftovers(root), []);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
