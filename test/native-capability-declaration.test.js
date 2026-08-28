import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLAUDE_PROMPT = 'templates/claude-system.md';
const CODEX_PROMPT = 'templates/codex-system.md';
const RUNTIME_PROMPTS = [CLAUDE_PROMPT, CODEX_PROMPT];

const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

/**
 * Why this file exists, and why it now asserts the opposite of what it used to.
 *
 * 0.1.20 added a "What You Can Already Do" section listing the agent's native
 * abilities, because the Codex prompt had shipped the false line "No built-in
 * WebSearch/WebFetch". Removing a false claim was right. Replacing it with a
 * true list was not: a list of capabilities is a fact that expires. Runtimes
 * gain abilities, machines differ, components come and go — and every future
 * editor has to keep the prose in step with reality or the prompt starts lying
 * again in the other direction. 0.1.21 had to ship an installer fix for
 * exactly that: the list named `unzip` and `python3`, which the installer did
 * not put on the machine.
 *
 * The owner's call (2026-08-28) was to stop describing capabilities at all and
 * describe the *procedure* instead: when a request arrives, look for an
 * existing capability, and if none fits go find a solution. The agent's
 * abilities are then discovered by attempting the work, which is the only
 * source that cannot go stale.
 *
 * So the lock has two directions now, and both matter:
 *   - the prompt must NOT assert a capability is missing (the 0.1.19 bug), and
 *   - the prompt must NOT enumerate capabilities either (the 0.1.20 fix that
 *     became 0.1.21's bug).
 * Between them sits the behaviour that survives any capability list, and those
 * rules are pinned here too.
 */
describe('runtime prompts describe how to meet a request, not what the agent can do', () => {
  test.each(RUNTIME_PROMPTS)('%s has no capability enumeration', relativePath => {
    const prompt = read(relativePath);

    // The exact heading that shipped in 0.1.20/0.1.21, named so a revert is
    // caught by name and not only by the generic assertions below.
    expect(prompt).not.toMatch(/## What You Can Already Do/);
    expect(prompt).not.toMatch(/\*\*Read documents\*\*/);
    expect(prompt).not.toMatch(/\*\*See images\*\*/);
    expect(prompt).not.toMatch(/\*\*Search the web\*\*/);
  });

  test.each(RUNTIME_PROMPTS)('%s says outright that it is not a capability list', relativePath => {
    // The instruction that replaces the list has to be explicit, otherwise the
    // next reader fills the gap back in with prose.
    expect(read(relativePath)).toMatch(/This document does not list what you can do/);
  });

  test.each(RUNTIME_PROMPTS)('%s routes an open request to existing capabilities first', relativePath => {
    const prompt = read(relativePath);

    expect(prompt).toMatch(/## Meeting a Request/);
    expect(prompt).toMatch(/`yos capability list`/);
    expect(prompt).toMatch(/`yos search`/);
    // Then outward, rather than stopping at "we don't have that".
    expect(prompt).toMatch(/If nothing fits, go find a solution/);
  });

  test.each(RUNTIME_PROMPTS)('%s puts that procedure before the behaviour rules', relativePath => {
    // The agent should learn how to approach a request before it learns the
    // house rules for carrying one out.
    const prompt = read(relativePath);

    expect(prompt.indexOf('## Meeting a Request')).toBeGreaterThan(-1);
    expect(prompt.indexOf('## Meeting a Request')).toBeLessThan(prompt.indexOf('## Behavioral Rules'));
  });

  test.each(RUNTIME_PROMPTS)('%s still requires confirmation before installing what it finds', relativePath => {
    // "Go find a solution" without this line is an instruction to install
    // arbitrary code on a customer's machine unattended.
    const prompt = read(relativePath);

    expect(prompt).toMatch(/Skill Security Review/);
    expect(prompt).toMatch(/confirmation via C4 before\s+installing it/);
  });
});

describe('runtime prompts keep the rules that outlive any capability list', () => {
  test.each(RUNTIME_PROMPTS)('%s forbids an untested "I can\'t"', relativePath => {
    // This is the rule that makes capability discovery work: with no list to
    // consult, "I can't" may only be said after a real attempt.
    const prompt = read(relativePath);

    expect(prompt).toMatch(/"I can't" is a claim, and claims need evidence/);
    expect(prompt).toMatch(/try it once/);
  });

  test.each(RUNTIME_PROMPTS)('%s forbids answering a live fact from memory', relativePath => {
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
  });

  test.each(RUNTIME_PROMPTS)('%s states the date rule as one case of the live-fact rule', relativePath => {
    // Merged deliberately: a date is a live fact. It used to appear twice in
    // two different wordings, which is how two copies drift apart. The exact
    // phrases are pinned by date-verification-guidance.test.js; this assertion
    // is about where they live and that there is only one of them.
    const prompt = read(relativePath);
    const liveFactRule = prompt.slice(
      prompt.indexOf('**Never answer a live fact from memory.**'),
      prompt.indexOf('**"I can\'t" is a claim')
    );

    expect(liveFactRule).toMatch(/Never compute dates\s+mentally/);
    expect(prompt.match(/Never compute dates\s+mentally/g)).toHaveLength(1);
  });
});

/**
 * The prompt must never claim an ability is absent. This is the original
 * regression (shipped in the Codex prompt through 0.1.18) and it is the one
 * failure mode that removing the capability list does not address on its own:
 * a future editor "helpfully" documenting a limitation reintroduces it.
 */
describe('runtime prompts never assert a missing capability', () => {
  it('never tells Codex it has no web search (the regression that shipped)', () => {
    const prompt = read(CODEX_PROMPT);

    expect(prompt).not.toMatch(/No built-in WebSearch/);
    expect(prompt).not.toMatch(/no built-in web search/i);
  });

  test.each(RUNTIME_PROMPTS)('%s asserts no missing tool in any wording', relativePath => {
    // Both wordings seen on real customer machines are covered: the upstream
    // "No built-in X" and the 元知 machine's "You do not have built-in `X`".
    const prompt = read(relativePath);

    expect(prompt).not.toMatch(/You do not have (?:an? )?built-in/i);
    expect(prompt).not.toMatch(/\bno built-in\b/i);
    expect(prompt).not.toMatch(/lacks? (?:an? )?built-in/i);
  });
});

/**
 * Why this block survives the redesign.
 *
 * 0.1.21 fixed a real defect: the manual named `unzip` and `python3` while
 * install.sh guaranteed only curl, git, tmux and node, so a stock
 * ubuntu:24.04 machine could not honour a sentence the manual had written.
 * The old guard read that command list out of the capability section — and
 * that section is now gone, which would have let the guard pass vacuously on
 * an empty list. That is precisely how a check rots into decoration, so the
 * guard is re-anchored rather than deleted.
 *
 * The invariant it protects is unchanged and, if anything, matters more now:
 * with no manual telling the agent how to read a .docx, the agent will reach
 * for the obvious tool, and the tool has to be there. What a factory install
 * guarantees is asserted here directly against install.sh, instead of being
 * derived from prose that no longer exists.
 */
describe('the installer guarantees the factory document toolset', () => {
  const INSTALLER = 'scripts/install.sh';

  /** Commands install.sh actually calls an `ensure_*` for in its main flow. */
  const installerPrerequisites = () => new Set(
    [...read(INSTALLER).matchAll(/^\s*ensure_([a-z0-9_]+)\s*$/gm)].map(match => match[1])
  );

  it('reads a non-empty prerequisite list out of install.sh', () => {
    // If this ever goes empty every assertion below would pass vacuously.
    const prerequisites = installerPrerequisites();

    expect(prerequisites.size).toBeGreaterThan(0);
    expect(prerequisites).toContain('node');
  });

  it('installs unzip and python3, the pair 0.1.21 had to go back and add', () => {
    const installer = read(INSTALLER);
    const prerequisites = installerPrerequisites();

    expect(prerequisites).toContain('unzip');
    expect(prerequisites).toContain('python3');
    expect(installer).toMatch(/ensure_unzip\(\)/);
    expect(installer).toMatch(/ensure_python3\(\)/);
  });

  it('does not abort an otherwise good install when they cannot be installed', () => {
    // These two support a capability, they are not needed for YOS to run.
    // Hard-failing here would turn a documentation gap into a broken install on
    // any machine without a usable package manager, which is a worse product
    // than the bug being fixed.
    const installer = read(INSTALLER);

    expect(installer).toMatch(/can_install_packages\(\)/);
    expect(installer).toMatch(/ensure_document_tool\(\)/);
    // The soft path must warn rather than call fail().
    const helper = installer.slice(
      installer.indexOf('ensure_document_tool() {'),
      installer.indexOf('ensure_unzip() {')
    );
    expect(helper).toMatch(/warn /);
    expect(helper).not.toMatch(/\bfail /);
  });
});

/**
 * The prompt got shorter by moving detail into a file it points at. A pointer
 * to a file the installer never deploys is worse than the inline text it
 * replaced: the agent follows it, finds nothing, and ends up with no rules at
 * all.
 */
describe('every instruction file the prompts point at actually ships', () => {
  const referencedInstructionFiles = relativePath => [
    ...read(relativePath).matchAll(/~\/yos\/\.yos\/instructions\/([A-Za-z0-9._-]+\.md)/g),
  ].map(match => match[1]);

  test.each(RUNTIME_PROMPTS)('%s points only at templates that exist', relativePath => {
    const referenced = referencedInstructionFiles(relativePath);

    expect(referenced.length).toBeGreaterThan(0);
    for (const file of referenced) {
      expect(fs.existsSync(path.join(ROOT, 'templates', file))).toBe(true);
    }
  });

  test.each(RUNTIME_PROMPTS)('%s hands the memory rules off to a file, not inline prose', relativePath => {
    const prompt = read(relativePath);

    expect(prompt).toMatch(/~\/yos\/\.yos\/instructions\/memory-system\.md/);
    // The bookkeeping detail must not creep back into the always-loaded prompt.
    expect(prompt).not.toMatch(/### Classification Rules for reference\/ Files/);
    expect(prompt).not.toMatch(/Target ≤8KB/);
  });

  it('deploys memory-system.md the same way it deploys onboarding.md', () => {
    // Reading the builder rather than running it keeps this test fast; the
    // round trip itself is covered by the split-instruction tests.
    const builder = read('cli/lib/runtime/instruction-builder.js');

    expect(builder).toMatch(/memorySystemPath: path\.join\(instructionsDir, 'memory-system\.md'\)/);
    expect(builder).toMatch(/Memory system instruction template not found/);
    // Both deploy paths — first install and refresh — must carry it.
    expect(builder.match(/memory-system\.md/g).length).toBeGreaterThanOrEqual(3);
  });
});
