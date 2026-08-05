import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  loadApprovedTestBaselines,
  verifyJestResult,
  verifyNodeTapResult,
} from './test-baseline-policy.js';

const TEST_FILE = /(^|\/)(?:__tests__\/.*|tests?\/.*|[^/]+\.(?:test|spec))\.(?:[cm]?js|jsx|ts|tsx)$/;
const CONFIG_FILE = /(^|\/)(?:jest\.config\.[^/]+|package\.json|run-[^/]*tests?\.[^/]+)$/;
const DISABLED_CALL = /\b(describe|it|test)\s*\.\s*(skip|todo|only)\s*\(|\b(xdescribe|xit|xtest)\s*\(/g;
const JEST_IGNORE_PROPERTY = /\btestPathIgnorePatterns\s*:/g;
const JEST_IGNORE_JSON_PROPERTY = /"testPathIgnorePatterns"\s*:/g;
const JEST_IGNORE_CLI = /--testPathIgnorePatterns\b/g;
const ACTIVE_TEST = /\b(?:it|test)\s*\(/g;

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function stripCommentsAndStrings(source) {
  let result = '';
  let mode = 'code';
  let quote = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === 'line-comment') {
      if (char === '\n') {
        mode = 'code';
        result += '\n';
      } else {
        result += ' ';
      }
      continue;
    }
    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        result += '  ';
        index += 1;
        mode = 'code';
      } else {
        result += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (mode === 'string') {
      if (char === '\\') {
        result += ' ';
        if (index + 1 < source.length) {
          index += 1;
          result += source[index] === '\n' ? '\n' : ' ';
        }
      } else if (char === quote) {
        result += ' ';
        mode = 'code';
      } else {
        result += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      result += '  ';
      index += 1;
      mode = 'line-comment';
    } else if (char === '/' && next === '*') {
      result += '  ';
      index += 1;
      mode = 'block-comment';
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
      result += ' ';
      mode = 'string';
    } else {
      result += char;
    }
  }
  return result;
}

function finding(pathname, source, match, kind) {
  return { path: pathname, line: lineNumberAt(source, match.index), kind };
}

export function findDisabledTests(files) {
  const findings = [];
  for (const file of files) {
    const normalizedPath = file.path.split(path.sep).join('/');
    const sanitized = stripCommentsAndStrings(file.source);

    if (TEST_FILE.test(normalizedPath)) {
      for (const match of sanitized.matchAll(DISABLED_CALL)) {
        const kind = match[3] || `${match[1]}.${match[2]}`;
        findings.push(finding(normalizedPath, file.source, match, kind));
      }
    }

    if (CONFIG_FILE.test(normalizedPath)) {
      for (const match of sanitized.matchAll(JEST_IGNORE_PROPERTY)) {
        findings.push(finding(normalizedPath, file.source, match, 'testPathIgnorePatterns'));
      }
      if (normalizedPath.endsWith('package.json')) {
        for (const match of file.source.matchAll(JEST_IGNORE_JSON_PROPERTY)) {
          findings.push(finding(normalizedPath, file.source, match, 'testPathIgnorePatterns'));
        }
      }
      for (const match of file.source.matchAll(JEST_IGNORE_CLI)) {
        findings.push(finding(normalizedPath, file.source, match, '--testPathIgnorePatterns'));
      }
    }
  }
  return findings;
}

export function loadApprovedSkipAllowlist(policyPath) {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read skip allowlist: ${error.message}`);
  }
  if (policy.version !== 1 || !Array.isArray(policy.entries)) {
    throw new Error('skip allowlist has an unsupported schema');
  }
  const actualDigest = crypto.createHash('sha256')
    .update(JSON.stringify(policy.entries))
    .digest('hex');
  if (policy.approvedDigest !== actualDigest) {
    throw new Error(`skip allowlist approval digest mismatch: expected ${policy.approvedDigest}, got ${actualDigest}`);
  }
  for (const entry of policy.entries) {
    if (!entry.path || !Number.isInteger(entry.line) || !entry.kind || !entry.reason || !entry.proposer) {
      throw new Error('each skip allowlist entry requires path, line, kind, reason, and proposer');
    }
  }
  return policy.entries;
}

export function listTrackedFiles(root, { gitCommand = 'git' } = {}) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    throw new Error('Git worktree is required for test-policy verification');
  }
  const result = spawnSync(gitCommand, ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(`could not list tracked files for test-policy verification: ${reason}`);
  }
  const files = result.stdout.split('\0').filter(Boolean);
  if (files.length === 0) throw new Error('Git returned no tracked files for test-policy verification');
  return files;
}

function countActiveTests(source) {
  return [...stripCommentsAndStrings(source).matchAll(ACTIVE_TEST)].length;
}

export function verifyCriticalTestFiles(root, manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('critical test manifest has an unsupported or empty schema');
  }
  for (const entry of manifest.files) {
    const absolutePath = path.join(root, entry.path);
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`missing critical file: ${entry.path}`);
    }
    if (entry.minimumTests !== undefined) {
      const count = countActiveTests(fs.readFileSync(absolutePath, 'utf8'));
      if (count < entry.minimumTests) {
        throw new Error(`${entry.path}: expected at least ${entry.minimumTests} test case, found ${count}`);
      }
    }
  }
}

function mustReject(label, operation) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`${label} did not reject a below-baseline result`);
}

export function verifyTestBaselineGuard(root) {
  const baselines = loadApprovedTestBaselines(path.join(root, 'scripts', 'test-baselines.json'));
  mustReject('Jest baseline guard', () => verifyJestResult({
    numPassedTests: Math.max(0, baselines.jest.minimumPassed - 1),
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  }, baselines.jest));
  mustReject('Node baseline guard', () => verifyNodeTapResult([
    `# tests ${baselines.node.minimumPassed}`,
    `# pass ${Math.max(0, baselines.node.minimumPassed - 1)}`,
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n'), baselines.node));

  const verifySource = fs.readFileSync(path.join(root, 'scripts', 'verify.js'), 'utf8');
  const gateReturnIndex = /^\s*return verifyExecutedTestsImpl\(root, baselines\);\s*$/m.exec(verifySource)?.index ?? -1;
  const legacyVerdictIndex = /^\s*return verifyExecutedTestCountsImpl\(counts, baselines\) === counts;\s*$/m.exec(verifySource)?.index ?? -1;
  const runIndex = verifySource.indexOf('export function runVerification({');
  const runSource = runIndex >= 0 ? verifySource.slice(runIndex) : '';
  const decisionStart = runSource.indexOf('let failed = false;');
  const decisionSource = decisionStart >= 0 ? runSource.slice(decisionStart) : runSource;
  const declarationIndex = /^\s*let counts = null;\s*$/m.exec(decisionSource)?.index ?? -1;
  const tryIndex = /^\s*try \{\s*$/m.exec(decisionSource)?.index ?? -1;
  const gateIndex = /^\s*counts = executeTestGateImpl\(\{\s*$/m.exec(decisionSource)?.index ?? -1;
  const catchIndex = /^\s*\} catch \(error\) \{\s*$/m.exec(decisionSource)?.index ?? -1;
  const validatorIndex = /^\s*verifyExecutedTestCountsImpl\(counts, approvedBaselines\);\s*$/m.exec(decisionSource)?.index ?? -1;
  const auditIndex = decisionSource.indexOf('verifyAuditsImpl(root);');
  const packIndex = decisionSource.indexOf('verifyReproduciblePackImpl(root);');
  if (legacyVerdictIndex >= 0) {
    throw new Error('executed-test gate must return raw counts');
  }
  if (gateReturnIndex < 0 || gateIndex < 0) {
    throw new Error('executed-test gate is missing from verification');
  }
  if (validatorIndex < 0) {
    throw new Error('executed-test count validator is missing from verification');
  }
  if (tryIndex < 0 || declarationIndex < 0 || declarationIndex > tryIndex) {
    throw new Error('executed-test verification state must be declared before the verification try block');
  }
  if (catchIndex < 0 || validatorIndex < catchIndex) {
    throw new Error('executed-test count validator must be enforced after the verification catch block');
  }
  if (auditIndex < 0 || packIndex < 0
    || gateIndex > catchIndex || validatorIndex > auditIndex || validatorIndex > packIndex) {
    throw new Error('executed-test gate must run before audits and packaging');
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read ${label}: ${error.message}`);
  }
}

export function verifyTestPolicy({
  root,
  gitCommand = 'git',
  allowlistPath = path.join(root, 'scripts', 'test-skip-allowlist.json'),
  criticalManifestPath = path.join(root, 'scripts', 'critical-test-files.json'),
} = {}) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('test-policy scan root is missing');
  }
  const tracked = listTrackedFiles(root, { gitCommand });
  const scanPaths = tracked.filter((file) => TEST_FILE.test(file) || CONFIG_FILE.test(file));
  if (scanPaths.length === 0) throw new Error('test-policy scan found no tracked test or configuration files');

  const files = scanPaths.map((file) => ({
    path: file,
    source: fs.readFileSync(path.join(root, file), 'utf8'),
  }));
  const allowlist = loadApprovedSkipAllowlist(allowlistPath);
  const allowed = new Set(allowlist.map((entry) => `${entry.path}:${entry.line}:${entry.kind}`));
  const blocked = findDisabledTests(files)
    .filter((entry) => !allowed.has(`${entry.path}:${entry.line}:${entry.kind}`));
  if (blocked.length > 0) {
    throw new Error(`disabled or focused tests are forbidden:\n${blocked
      .map((entry) => `${entry.path}:${entry.line} ${entry.kind}`)
      .join('\n')}`);
  }

  verifyCriticalTestFiles(root, readJson(criticalManifestPath, 'critical test manifest'));
  verifyTestBaselineGuard(root);
  return { scannedFiles: scanPaths.length, criticalFiles: readJson(criticalManifestPath, 'critical test manifest').files.length };
}
