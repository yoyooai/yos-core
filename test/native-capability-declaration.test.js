import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLAUDE_PROMPT = 'templates/claude-system.md';
const CODEX_PROMPT = 'templates/codex-system.md';
const RUNTIME_PROMPTS = [CLAUDE_PROMPT, CODEX_PROMPT];

const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const capabilitySection = prompt => prompt.slice(
  prompt.indexOf('## What You Can Already Do'),
  prompt.indexOf('## Behavioral Rules')
);

/**
 * Why this file exists: the shipped Codex prompt asserted "No built-in
 * WebSearch/WebFetch", which is false — the runtime searches the web on a
 * factory install, verified on a real machine — and neither prompt ever told
 * the agent what it could do.
 *
 * Scope, stated honestly: removing a false claim from a customer-facing
 * artifact is the whole justification here. It is NOT demonstrated that the
 * false line caused an agent to refuse work — asked point blank whether it
 * could read a PDF or search the web, the agent said yes under the old prompt
 * too. What did reproduce is the opposite failure: answering a live fact from
 * memory rather than checking. That one is still open.
 *
 * These assertions are the lock. If the capability declaration is dropped or
 * the false claim comes back, this goes red instead of the regression reaching
 * a customer silently.
 */
describe('runtime prompts declare native capabilities', () => {
  test.each(RUNTIME_PROMPTS)('%s has a capability section', relativePath => {
    const prompt = read(relativePath);

    expect(prompt).toMatch(/## What You Can Already Do/);
    // The section must come before the behavioural rules, i.e. the agent learns
    // what it has before it learns how to behave.
    expect(prompt.indexOf('## What You Can Already Do')).toBeLessThan(
      prompt.indexOf('## Behavioral Rules')
    );
  });

  test.each(RUNTIME_PROMPTS)('%s names documents, images, and web access', relativePath => {
    const section = capabilitySection(read(relativePath));

    expect(section).toMatch(/\*\*Read documents\*\*/);
    expect(section).toMatch(/\*\*See images\*\*/);
    expect(section).toMatch(/\*\*Search the web\*\*/);
    expect(section).toMatch(/PDF/);
  });

  test.each(RUNTIME_PROMPTS)('%s forbids an untested "I can\'t"', relativePath => {
    const prompt = read(relativePath);

    expect(prompt).toMatch(/"I can't" is a claim, and claims need evidence/);
    expect(prompt).toMatch(/try it once/);
  });

  test.each(RUNTIME_PROMPTS)(
    '%s tells the agent not to widen one bad file into a missing capability',
    relativePath => {
      // The failure mode this guards is the mirror image of the original bug:
      // a scanned PDF with no text layer is a fact about that file, and must not
      // become "I cannot read documents".
      const section = capabilitySection(read(relativePath));

      expect(section).toMatch(/scan with no text layer/);
      expect(section).toMatch(/never widen it into "I\s+cannot\s+read\s+documents"/);
    }
  );

  test.each(RUNTIME_PROMPTS)(
    '%s claims capabilities as verified rather than assumed',
    relativePath => {
      // Every line in this section was checked on a real factory install before
      // being written down. Saying so is what keeps the next editor honest.
      const section = capabilitySection(read(relativePath));

      expect(section).toMatch(/factory install/);
    }
  );

  test.each(RUNTIME_PROMPTS)(
    '%s forbids answering a live fact from memory',
    relativePath => {
      // Present because a real A/B on the test machine found this failure, NOT
      // because the wording is proven to cure it. Asked what an index closed at
      // today, the agent answered from memory — a different fabricated number
      // each run, no search attempted — and it kept doing so after this rule was
      // added, while being able to quote the rule back verbatim. The rule stays
      // because it is true and belongs in the prompt; the behaviour is tracked
      // as debt, not claimed as fixed. Do not delete it on the theory that it
      // "does nothing" without re-running that A/B.
      const prompt = read(relativePath);

      expect(prompt).toMatch(/Never answer a live fact from memory/);
      expect(prompt).toMatch(/A confident stale number is worse than "let me\s+check"/);
    }
  );

  it('never tells Codex it has no web search (the regression that shipped)', () => {
    const prompt = read(CODEX_PROMPT);

    expect(prompt).not.toMatch(/No built-in WebSearch/);
    expect(prompt).not.toMatch(/no built-in web search/i);
  });

  it('tells Codex its web search needs no flag or config', () => {
    // Measured, not assumed: on a factory 0.1.19 machine the interactive runtime
    // searched the web with no [tools] entry present at all. An instruction that
    // sends the agent hunting for a switch is the same bug in a new costume.
    const section = capabilitySection(read(CODEX_PROMPT));

    expect(section).toMatch(/no flag and no config entry/);
  });

  it('points Claude Code at its own web tools', () => {
    const section = capabilitySection(read(CLAUDE_PROMPT));

    expect(section).toMatch(/`WebSearch` and `WebFetch` are built in/);
  });

  test.each(RUNTIME_PROMPTS)(
    '%s tells the agent how to get at Office formats instead of giving up',
    relativePath => {
      // Verified on the real machine: the agent extracted a .docx and .xlsx
      // passphrase with plain `unzip`, nothing installed. Neither runtime has a
      // native Office reader, so the instruction has to name the route.
      const section = capabilitySection(read(relativePath));

      expect(section).toMatch(/unzip -p/);
    }
  );
});
