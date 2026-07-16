import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { YOS_DIR } from '../config.js';
import {
  assembleInstruction,
  needsRebuild as leafNeedsRebuild,
  renderInstruction,
} from './assembler.mjs';

const PACKAGE_ROOT = path.join(import.meta.dirname, '..', '..', '..');
const DEFAULT_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');
const ASSEMBLER_SOURCE = path.join(import.meta.dirname, 'assembler.mjs');
export const SPLIT_MARKER_VERSION = 1;
export const CURRENT_INSTRUCTION_FORMAT_VERSION = 2;

export function instructionFormatVersionPath({ yosDir = YOS_DIR } = {}) {
  return path.join(path.resolve(yosDir), '.yos', 'instruction-format-version');
}

export function readInstructionFormatVersion({ yosDir = YOS_DIR, io = {} } = {}) {
  const filePath = instructionFormatVersionPath({ yosDir });
  const existsSync = io.existsSync ?? fs.existsSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  if (!existsSync(filePath)) return { version: null, valid: true, exists: false, filePath };
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (!/^[1-9]\d*\n?$/.test(raw)) {
      return { version: null, valid: false, exists: true, filePath };
    }
    const version = Number(raw.trim());
    if (!Number.isSafeInteger(version)) {
      return { version: null, valid: false, exists: true, filePath };
    }
    return { version, valid: true, exists: true, filePath };
  } catch (error) {
    return { version: null, valid: false, exists: true, filePath, error };
  }
}

export function writeInstructionFormatVersion({
  yosDir = YOS_DIR,
  version = CURRENT_INSTRUCTION_FORMAT_VERSION,
  io = {},
} = {}) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new TypeError('instruction format version must be a positive integer');
  }
  const filePath = instructionFormatVersionPath({ yosDir });
  const writeFileSync = io.writeFileSync ?? fs.writeFileSync;
  const renameSync = io.renameSync ?? fs.renameSync;
  const openSync = io.openSync ?? fs.openSync;
  const fsyncSync = io.fsyncSync ?? fs.fsyncSync;
  const closeSync = io.closeSync ?? fs.closeSync;
  const unlinkSync = io.unlinkSync ?? fs.unlinkSync;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  let fd;
  try {
    writeFileSync(tempPath, `${version}\n`, 'utf8');
    fd = openSync(tempPath, 'r');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, filePath);
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { }
    try { unlinkSync(tempPath); } catch { }
  }
  return { version, filePath };
}

function assertRuntime(runtime) {
  if (runtime !== 'claude' && runtime !== 'codex') {
    throw new TypeError(`Unsupported runtime: ${runtime}`);
  }
}

export function instructionPaths(runtime, { yosDir = YOS_DIR } = {}) {
  assertRuntime(runtime);
  const root = path.resolve(yosDir);
  const instructionsDir = path.join(root, '.yos', 'instructions');
  return {
    instructionsDir,
    markerPath: path.join(instructionsDir, 'meta.json'),
    assemblerPath: path.join(instructionsDir, 'assembler.mjs'),
    onboardingPath: path.join(instructionsDir, 'onboarding.md'),
    systemPath: path.join(instructionsDir, `${runtime}-system.md`),
    userPath: path.join(root, 'YOS.md'),
    outputPath: path.join(root, runtime === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'),
  };
}

export function isSplitInstructionsActive({ yosDir = YOS_DIR } = {}) {
  return fs.existsSync(instructionPaths('claude', { yosDir }).markerPath);
}

export function needsRebuild(runtime, { yosDir = YOS_DIR } = {}) {
  const paths = instructionPaths(runtime, { yosDir });
  if (!fs.existsSync(paths.markerPath)) return false;
  return leafNeedsRebuild(paths);
}

export function buildInstructionFile(runtime, { yosDir = YOS_DIR, force = false } = {}) {
  const paths = instructionPaths(runtime, { yosDir });
  if (!fs.existsSync(paths.markerPath)) throw unsupportedInstructionLayout(paths.markerPath);
  if (force || leafNeedsRebuild(paths)) assembleInstruction(paths);
  return paths.outputPath;
}

export function assertInstructionReady(runtime, { yosDir = YOS_DIR } = {}) {
  const paths = instructionPaths(runtime, { yosDir });
  if (!fs.existsSync(paths.markerPath)) throw unsupportedInstructionLayout(paths.markerPath);
  if (!fs.existsSync(paths.outputPath) || leafNeedsRebuild(paths)) {
    throw new Error(`${runtime} instruction file was not prepared before launch: ${paths.outputPath}`);
  }
  return true;
}

function unsupportedInstructionLayout(markerPath) {
  return new Error(
    `Unsupported instruction layout: current YOS split marker is missing at ${markerPath}; initialize a fresh YOS installation.`,
  );
}

export function buildAllInstructionFiles(options = {}) {
  buildInstructionFile('claude', options);
  buildInstructionFile('codex', options);
}

export function getInstructionFilePath(runtime, options = {}) {
  return instructionPaths(runtime, options).outputPath;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const existingMode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : null;
  try {
    fs.writeFileSync(tmpPath, content);
    if (existingMode !== null) fs.chmodSync(tmpPath, existingMode);
    fs.renameSync(tmpPath, filePath);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { }
  }
}

export function deployInstructionAssets({
  yosDir = YOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
} = {}) {
  const paths = instructionPaths('claude', { yosDir });
  fs.mkdirSync(paths.instructionsDir, { recursive: true });
  for (const runtime of ['claude', 'codex']) {
    const source = path.join(templatesDir, `${runtime}-system.md`);
    if (!fs.existsSync(source)) throw new Error(`System instruction template not found: ${source}`);
    atomicWrite(instructionPaths(runtime, { yosDir }).systemPath, fs.readFileSync(source));
  }
  const onboardingSource = path.join(templatesDir, 'onboarding.md');
  if (!fs.existsSync(onboardingSource)) throw new Error(`Onboarding instruction template not found: ${onboardingSource}`);
  atomicWrite(paths.onboardingPath, fs.readFileSync(onboardingSource));
  atomicWrite(paths.assemblerPath, fs.readFileSync(assemblerSource));
  return paths.instructionsDir;
}

function splitTransactionRoots(yosDir) {
  return [path.resolve(yosDir), instructionPaths('claude', { yosDir }).instructionsDir];
}

export function hasSplitTransactionResidue(yosDir) {
  for (const root of splitTransactionRoots(yosDir)) {
    try {
      if (fs.readdirSync(root).some(name => name.includes('.split-txn.'))) return true;
    } catch { }
  }
  return false;
}

function cleanupSplitTemps(yosDir) {
  for (const root of splitTransactionRoots(yosDir)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      if (!name.includes('.split-txn.')) continue;
      // Backups are recovery records, not disposable temporary files.
      if (name.endsWith('.bak')) continue;
      try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { }
    }
  }
}

export function recoverSplitTransaction(yosDir, faultInjector = () => {}) {
  const markerPath = instructionPaths('claude', { yosDir }).markerPath;
  let committedTransactionId;
  try {
    committedTransactionId = JSON.parse(fs.readFileSync(markerPath, 'utf8')).transactionId;
  } catch { }

  const backups = [];
  for (const root of splitTransactionRoots(yosDir)) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) {
      const match = name.match(/^(.*)\.split-txn\.([^.]+\.[^.]+\.[^.]+)\.bak$/);
      if (!match) continue;
      backups.push({
        backupPath: path.join(root, name),
        path: path.join(root, match[1]),
        token: match[2],
        name: match[1],
      });
    }
  }

  const errors = [];
  for (const backup of backups) {
    try {
      if (backup.token === committedTransactionId) {
        faultInjector(`recover:discard:${backup.name}`);
        fs.unlinkSync(backup.backupPath);
      } else {
        faultInjector(`recover:restore:${backup.name}`);
        fs.renameSync(backup.backupPath, backup.path);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'split instruction transaction recovery failed');
  }
  cleanupSplitTemps(yosDir);
}

function commitEntries(entries, markerPath, markerContent, faultInjector = () => {}) {
  const token = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const staged = [];
  const backups = [];
  const applied = [];
  let markerStage;
  let committed = false;
  let rollbackFailed = false;

  try {
    for (const entry of entries) {
      faultInjector(`stage:${entry.name}`);
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      const stagePath = `${entry.path}.split-txn.${token}`;
      const existingMode = fs.existsSync(entry.path) ? fs.statSync(entry.path).mode & 0o777 : null;
      fs.writeFileSync(stagePath, entry.content);
      staged.push({ ...entry, stagePath });
      if (existingMode !== null) fs.chmodSync(stagePath, existingMode);
    }
    faultInjector('stage:marker');
    markerStage = `${markerPath}.split-txn.${token}`;
    const marker = JSON.parse(markerContent);
    marker.transactionId = token;
    fs.writeFileSync(markerStage, JSON.stringify(marker, null, 2) + '\n', 'utf8');
    if (fs.existsSync(markerPath)) fs.chmodSync(markerStage, fs.statSync(markerPath).mode & 0o777);

    for (const entry of staged) {
      if (fs.existsSync(entry.path)) {
        const backupPath = `${entry.path}.split-txn.${token}.bak`;
        fs.renameSync(entry.path, backupPath);
        backups.push({ name: entry.name, path: entry.path, backupPath });
      }
      faultInjector(`rename:${entry.name}`);
      fs.renameSync(entry.stagePath, entry.path);
      applied.push(entry);
    }

    faultInjector('rename:marker');
    fs.renameSync(markerStage, markerPath);
    committed = true;
  } catch (error) {
    if (!committed) {
      const rollbackErrors = [];
      for (const entry of [...applied].reverse()) {
        try {
          faultInjector(`rollback:remove:${entry.name}`);
          fs.unlinkSync(entry.path);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const backup of [...backups].reverse()) {
        try {
          faultInjector(`rollback:restore:${backup.name}`);
          fs.renameSync(backup.backupPath, backup.path);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        rollbackFailed = true;
        throw new AggregateError(rollbackErrors, `split instruction rollback failed after: ${error.message}`, { cause: error });
      }
    }
    throw error;
  } finally {
    for (const entry of staged) {
      try { fs.unlinkSync(entry.stagePath); } catch { }
    }
    if (committed) {
      for (const backup of backups) {
        try {
          faultInjector(`cleanup:backup:${backup.name}`);
          fs.unlinkSync(backup.backupPath);
        } catch { }
      }
    }
    if (!rollbackFailed) {
      try { fs.unlinkSync(markerStage); } catch { }
    }
  }
}

export function activateFreshSplitInstructions({
  yosDir = YOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  faultInjector,
  versionIo,
} = {}) {
  const hadTransactionResidue = hasSplitTransactionResidue(yosDir);
  recoverSplitTransaction(yosDir, faultInjector);
  const claude = instructionPaths('claude', { yosDir });
  if (fs.existsSync(claude.markerPath)) {
    return refreshSplitInstructions({ yosDir, templatesDir, assemblerSource, faultInjector });
  }

  const legacyArtifacts = [claude.userPath, claude.outputPath, instructionPaths('codex', { yosDir }).outputPath];
  if (!hadTransactionResidue && legacyArtifacts.some(filePath => fs.existsSync(filePath))) {
    throw unsupportedInstructionLayout(claude.markerPath);
  }

  const userContent = fs.existsSync(claude.userPath)
    ? fs.readFileSync(claude.userPath, 'utf8')
    : fs.readFileSync(path.join(templatesDir, 'YOS.md'), 'utf8');
  const systems = Object.fromEntries(['claude', 'codex'].map(runtime => [
    runtime,
    fs.readFileSync(path.join(templatesDir, `${runtime}-system.md`), 'utf8'),
  ]));
  const now = new Date();
  const entries = [
    { name: 'claude-system', path: claude.systemPath, content: systems.claude },
    { name: 'codex-system', path: instructionPaths('codex', { yosDir }).systemPath, content: systems.codex },
    { name: 'onboarding', path: claude.onboardingPath, content: fs.readFileSync(path.join(templatesDir, 'onboarding.md'), 'utf8') },
    { name: 'assembler', path: claude.assemblerPath, content: fs.readFileSync(assemblerSource) },
  ];
  if (!fs.existsSync(claude.userPath)) {
    entries.push({ name: 'seed', path: claude.userPath, content: userContent });
  }
  for (const runtime of ['claude', 'codex']) {
    const paths = instructionPaths(runtime, { yosDir });
    const systemShadow = `${paths.systemPath}.split-render.${process.pid}`;
    const userShadow = `${paths.userPath}.split-render.${process.pid}`;
    fs.mkdirSync(path.dirname(systemShadow), { recursive: true });
    fs.writeFileSync(systemShadow, systems[runtime], 'utf8');
    fs.writeFileSync(userShadow, userContent, 'utf8');
    try {
      const content = renderInstruction({ systemPath: systemShadow, userPath: userShadow, generatedAt: now })
        .replaceAll(path.resolve(systemShadow), path.resolve(paths.systemPath))
        .replaceAll(path.resolve(userShadow), path.resolve(paths.userPath));
      entries.push({ name: `${runtime}-output`, path: paths.outputPath, content });
    } finally {
      try { fs.unlinkSync(systemShadow); } catch { }
      try { fs.unlinkSync(userShadow); } catch { }
    }
  }
  const marker = {
    schemaVersion: SPLIT_MARKER_VERSION,
    activatedAt: now.toISOString(),
    seedSha256: crypto.createHash('sha256').update(userContent).digest('hex'),
  };
  commitEntries(entries, claude.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  try {
    writeInstructionFormatVersion({ yosDir, io: versionIo });
    return { active: true, markerPath: claude.markerPath, versionWritten: true, versionWriteError: null };
  } catch (versionWriteError) {
    return { active: true, markerPath: claude.markerPath, versionWritten: false, versionWriteError };
  }
}

export function refreshSplitInstructions({
  yosDir = YOS_DIR,
  templatesDir = DEFAULT_TEMPLATES_DIR,
  assemblerSource = ASSEMBLER_SOURCE,
  faultInjector,
} = {}) {
  recoverSplitTransaction(yosDir, faultInjector);
  const claude = instructionPaths('claude', { yosDir });
  if (!fs.existsSync(claude.markerPath)) {
    throw unsupportedInstructionLayout(claude.markerPath);
  }
  const marker = JSON.parse(fs.readFileSync(claude.markerPath, 'utf8'));
  const userContent = fs.readFileSync(claude.userPath, 'utf8');
  const now = new Date();
  const entries = [];
  for (const runtime of ['claude', 'codex']) {
    const paths = instructionPaths(runtime, { yosDir });
    const systemContent = fs.readFileSync(path.join(templatesDir, `${runtime}-system.md`), 'utf8');
    entries.push({ name: `${runtime}-system`, path: paths.systemPath, content: systemContent });
    const systemShadow = `${paths.systemPath}.split-render.${process.pid}`;
    fs.mkdirSync(path.dirname(systemShadow), { recursive: true });
    fs.writeFileSync(systemShadow, systemContent, 'utf8');
    try {
      const content = renderInstruction({ systemPath: systemShadow, userPath: paths.userPath, generatedAt: now })
        .replaceAll(path.resolve(systemShadow), path.resolve(paths.systemPath));
      entries.push({ name: `${runtime}-output`, path: paths.outputPath, content });
    } finally {
      try { fs.unlinkSync(systemShadow); } catch { }
    }
  }
  entries.push({ name: 'onboarding', path: claude.onboardingPath, content: fs.readFileSync(path.join(templatesDir, 'onboarding.md'), 'utf8') });
  entries.push({ name: 'assembler', path: claude.assemblerPath, content: fs.readFileSync(assemblerSource) });
  marker.refreshedAt = now.toISOString();
  marker.userSha256 = crypto.createHash('sha256').update(userContent).digest('hex');
  commitEntries(entries, claude.markerPath, JSON.stringify(marker, null, 2) + '\n', faultInjector);
  return { active: true, markerPath: claude.markerPath };
}
