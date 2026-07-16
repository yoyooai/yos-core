import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RETIRED_BRAND_PATTERN = new RegExp(
  `\\b(?:${[['zy', 'los'], ['co', 'co']].map(parts => parts.join('')).join('|')})\\b`,
  'i',
);

const TEXT_EXTENSIONS = new Set([
  '.cjs', '.css', '.env', '.example', '.html', '.js', '.json', '.md', '.mjs', '.sh', '.template', '.toml',
]);

function collectTextFiles(relativeDir, result = []) {
  const absoluteDir = path.join(ROOT, relativeDir);
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      collectTextFiles(relativePath, result);
    } else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      result.push(relativePath);
    }
  }
  return result;
}

const PUBLIC_SURFACES = [
  'README.md',
  'README.zh-CN.md',
  'cli/yos.js',
  'skills/web-console/package.json',
  'skills/web-console/public/index.html',
  'skills/web-console/public/app.js',
  'templates/claude-system.md',
  'templates/codex-system.md',
  'templates/memory/identity.md',
  'templates/memory/references.md',
  'docker/entrypoint.sh',
  'registry.json',
  'CHANGELOG.md',
];

describe('YOS public brand surfaces', () => {
  test.each(PUBLIC_SURFACES)('%s is a YOS-owned surface', relativePath => {
    const content = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  test('package uses only the YOS package and executable identity', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('yos');
    expect(pkg.bin).toEqual({ yos: './cli/yos.js' });
  });

  test('obsolete marketing artwork is not shipped', () => {
    expect(fs.existsSync(path.join(ROOT, 'assets/posters'))).toBe(false);
  });

  test('license and shipped first-party text contain no retired brand identity', () => {
    const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
    expect(license).toMatch(/Copyright \(c\) 2026 YOS Team/);
    expect(fs.existsSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'))).toBe(false);

    const textFiles = [
      'LICENSE',
      'README.md',
      'README.zh-CN.md',
      'CHANGELOG.md',
      'package.json',
      'package-lock.json',
      ...collectTextFiles('cli'),
      ...collectTextFiles('docker'),
      ...collectTextFiles('docs'),
      ...collectTextFiles('scripts'),
      ...collectTextFiles('skills'),
      ...collectTextFiles('templates'),
    ];
    for (const relativePath of textFiles) {
      const content = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      expect({ relativePath, content }).not.toEqual(expect.objectContaining({
        content: expect.stringMatching(RETIRED_BRAND_PATTERN),
      }));
    }
  });

  test('retired instruction migration subsystem is not shipped', () => {
    for (const relativePath of [
      'cli/commands/migrate-instructions.js',
      'cli/lib/instruction-migration.js',
      'data/instruction-baselines/manifest.json',
      'scripts/export-instruction-baselines.js',
    ]) {
      expect(fs.existsSync(path.join(ROOT, relativePath))).toBe(false);
    }
    const cli = fs.readFileSync(path.join(ROOT, 'cli/yos.js'), 'utf8');
    expect(cli).not.toMatch(/migrate-instructions/);
  });

  test('shipped text has no placeholder release sources', () => {
    const textFiles = [
      'Dockerfile',
      'docker-compose.yml',
      '.gitignore',
      'CLAUDE.md',
      'README.md',
      'README.zh-CN.md',
      'CHANGELOG.md',
      'package.json',
      'registry.json',
      ...collectTextFiles('cli'),
      ...collectTextFiles('docker'),
      ...collectTextFiles('docs'),
      ...collectTextFiles('scripts'),
      ...collectTextFiles('skills'),
      ...collectTextFiles('templates'),
    ];
    for (const relativePath of textFiles) {
      const content = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
      expect({ relativePath, content }).not.toEqual(expect.objectContaining({
        content: expect.stringMatching(/yos-ai|ghcr\.io\/yos/),
      }));
    }
  });
});
