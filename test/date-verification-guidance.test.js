import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_PROMPTS = [
  'templates/claude-system.md',
  'templates/codex-system.md',
];

describe('runtime date verification guidance', () => {
  test.each(RUNTIME_PROMPTS)('%s requires system date verification', relativePath => {
    const prompt = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

    expect(prompt).toMatch(/Never compute dates\s+mentally/);
    expect(prompt).toMatch(/running `date`\s+before sending/);
    expect(prompt).toMatch(/re-check dates reused from another agent/);
  });
});
