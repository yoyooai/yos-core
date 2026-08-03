import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// This file names the legacy identifiers it is looking for, so scanning it would
// always report legacy support. It is the only self-exclusion.
const SELF = path.join('cli', 'lib', '__tests__', 'readme-compatibility-claims.test.js');

const SCAN_ROOTS = ['cli', 'skills', 'scripts'];
const SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.sh', '.cjs']);
const LEGACY_ENV_PREFIX = 'ZYLOS_';
const RETIRED_MIGRATION_MODULES = [
  path.join('cli', 'commands', 'migrate-instructions.js'),
  path.join('cli', 'lib', 'instruction-migration.js'),
  path.join('cli', 'lib', 'migrate.js'),
];

/**
 * The compatibility section of each README, keyed by its heading.
 *
 * `README.md` line 55 and `README.zh-CN.md` line 55 claimed, from the root
 * commit `ae85d6b` onward, that "existing runtime paths, environment variables
 * and the legacy executable remain temporarily available". All three were false
 * on the day they were written: the only bin entry is `yos`, the tree holds zero
 * ZYLOS_ references, and the in-place migration modules were deleted. Four
 * acceptance rounds read the changed code and never re-checked what the baseline
 * said about itself.
 *
 * These tests do not pin one answer. They assert that the READMEs and the code
 * agree: if backward compatibility is ever restored, the claim becomes true and
 * the documentation must say so again. Only disagreement fails.
 */
const READMES = [
  {
    file: 'README.md',
    heading: '## Current Compatibility Boundary',
    // Prose asserting that the old surface still works.
    retained: [/remain temporarily available/i, /legacy executable/i, /upgraded in place so/i],
    // Prose asserting that it does not.
    freshOnly: [/installs fresh only/i, /cannot be upgraded in place/i],
  },
  {
    file: 'README.zh-CN.md',
    heading: '## 当前兼容边界',
    retained: [/暂时保留/, /旧执行入口[^。]*保留/],
    freshOnly: [/只支持全新安装/, /无法原地升级/],
  },
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && SCAN_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

/** Files still referencing the pre-rename environment prefix. */
function filesReferencingLegacyEnv() {
  return SCAN_ROOTS.flatMap((root) => walk(path.join(ROOT, root)))
    .map((file) => path.relative(ROOT, file))
    .filter((rel) => rel !== SELF)
    .filter((rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').includes(LEGACY_ENV_PREFIX));
}

/** What the code actually supports, computed fresh rather than restated. */
function detectLegacySupport() {
  const bin = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).bin ?? {};
  const legacyEnvFiles = filesReferencingLegacyEnv();
  const migrationModules = RETIRED_MIGRATION_MODULES.filter((rel) =>
    fs.existsSync(path.join(ROOT, rel)),
  );
  const reasons = [
    ...Object.keys(bin)
      .filter((name) => name === 'zylos')
      .map((name) => `package.json bin declares "${name}"`),
    ...(fs.existsSync(path.join(ROOT, 'cli', 'zylos.js')) ? ['cli/zylos.js exists'] : []),
    ...legacyEnvFiles.map((rel) => `${rel} references ${LEGACY_ENV_PREFIX}`),
    ...migrationModules.map((rel) => `${rel} exists`),
  ];
  return { supported: reasons.length > 0, reasons };
}

function readSection(file, heading) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = text.indexOf(heading);
  assert.notEqual(
    start,
    -1,
    `${file} lost the "${heading}" section. The compatibility boundary must stay documented; ` +
      'deleting the section is not a way to make it true.',
  );
  const rest = text.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return rest.slice(0, next === -1 ? undefined : next);
}

describe('README compatibility claims match the code', () => {
  const legacy = detectLegacySupport();

  for (const { file, heading, retained, freshOnly } of READMES) {
    it(`${file} describes the install path the code implements`, () => {
      const section = readSection(file, heading);
      const claimsRetained = retained.filter((pattern) => pattern.test(section));
      const claimsFreshOnly = freshOnly.filter((pattern) => pattern.test(section));

      if (legacy.supported) {
        assert.ok(
          claimsRetained.length > 0,
          `${file} does not document backward compatibility, but the code still provides it: ` +
            `${legacy.reasons.join('; ')}. Document the retained surface.`,
        );
        assert.equal(
          claimsFreshOnly.length,
          0,
          `${file} claims fresh-install-only, but the code still provides backward ` +
            `compatibility: ${legacy.reasons.join('; ')}.`,
        );
        return;
      }

      assert.equal(
        claimsRetained.length,
        0,
        `${file} claims the legacy runtime surface is retained, but nothing in the tree ` +
          'provides it: bin exposes only "yos", no cli/zylos.js, zero ' +
          `${LEGACY_ENV_PREFIX} references and no in-place migration modules. ` +
          `Offending prose matched ${claimsRetained.join(', ')}.`,
      );
      assert.ok(
        claimsFreshOnly.length > 0,
        `${file} must state that this release installs fresh only and cannot be upgraded ` +
          'in place. Silence reads as "migration probably works".',
      );
    });
  }

  it('reports the retired in-place migration modules as absent', () => {
    for (const rel of RETIRED_MIGRATION_MODULES) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;
      assert.ok(
        legacy.supported,
        `${rel} came back, so detectLegacySupport() must report backward compatibility.`,
      );
    }
  });
});
