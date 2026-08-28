import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONBOARDING = path.join(ROOT, 'templates', 'onboarding.md');
const IDENTITY = path.join(ROOT, 'templates', 'memory', 'identity.md');
const PROFILE = path.join(ROOT, 'templates', 'memory', 'users', 'default', 'profile.md');
const CLI = path.join(ROOT, 'cli', 'yos.js');

const onboarding = () => fs.readFileSync(ONBOARDING, 'utf8');

/**
 * Why this file exists.
 *
 * templates/onboarding.md holds the first conversation a customer ever has. It
 * shipped for months telling the agent it could "control a browser to scrape
 * data" — no such capability exists in this repository — and asking the
 * customer to review third-party source code themselves, which is the agent's
 * job and not something a customer can do.
 *
 * Three failure modes, and only two are machine-checkable:
 *
 *   - Naming a command or a file that does not exist. Checked here against the
 *     CLI's own command table and against the memory templates, the same shape
 *     as the install-time guard that requires every tool the manual names to
 *     actually be installed.
 *   - Turning the meeting into a briefing. Checked here: the message asks the
 *     person something, stays short enough to read on a phone, and puts no
 *     paths or commands in front of them.
 *   - Promising a capability in prose. NOT checkable — no test can tell whether
 *     "I can control a browser" is true. That is why the file is byte-pinned
 *     instead: an edit cannot land without a human consciously re-signing it.
 *
 * The string-absence assertions below are deliberately narrow. They stop
 * specific withdrawn claims from being reintroduced; they do not and cannot
 * detect a newly invented one.
 */

/**
 * Reads the command table out of the CLI entry point by source rather than by
 * import: cli/yos.js calls main() on load, so importing it would run the CLI.
 */
function cliSubcommands(source = fs.readFileSync(CLI, 'utf8')) {
  const table = source.match(/const commands = \{([\s\S]*?)\n\};/);
  if (!table) throw new Error('could not find the command table in cli/yos.js');
  return new Set([...table[1].matchAll(/^ {2}([a-z][a-z-]*):/gm)].map(match => match[1]));
}

/** Every `yos <subcommand>` named inside backticks in the given text. */
function namedCommands(text) {
  return [...text.matchAll(/`yos ([a-z][a-z-]*)/g)].map(match => match[1]);
}

/**
 * The customer-facing text: each run of consecutive blockquote lines is one
 * rendering of the opening message — Chinese verbatim, then English for every
 * other language — checked one at a time rather than as one blob.
 */
function renderings(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      current ??= [];
      current.push(line.slice(1).trim());
    } else if (current) {
      blocks.push(current.join('\n').trim());
      current = null;
    }
  }
  if (current) blocks.push(current.join('\n').trim());
  return blocks;
}

describe('the first conversation names only commands that exist', () => {
  it('reads the real command table out of the CLI', () => {
    // A regex that silently matched nothing would make the check below pass by
    // having no command table to compare against.
    const commands = cliSubcommands();
    expect(commands.size).toBeGreaterThan(10);
    for (const expected of ['init', 'capability', 'search', 'stop']) {
      expect([...commands]).toContain(expected);
    }
  });

  it('finds the commands it is meant to check', () => {
    // Likewise vacuous if the onboarding text stopped naming any command.
    const named = namedCommands(onboarding());
    expect(named.length).toBeGreaterThanOrEqual(3);
    expect(named).toEqual(expect.arrayContaining(['capability', 'search', 'stop']));
  });

  it('names no command this CLI does not have', () => {
    const commands = cliSubcommands();
    expect(namedCommands(onboarding()).filter(name => !commands.has(name))).toEqual([]);
  });

  it('catches an invented command', () => {
    const commands = cliSubcommands();
    const fabricated = 'Run `yos frobnicate` to get started.';
    expect(namedCommands(fabricated).filter(name => !commands.has(name))).toEqual(['frobnicate']);
  });
});

describe('the opening message asks about the person', () => {
  // Earlier drafts of this file failed in both directions: one recited four
  // warnings at a stranger, another put filesystem paths and `yos stop` into
  // the opening message. Both were accurate and neither was readable.
  //
  // Two guards written for those drafts have been deliberately removed rather
  // than loosened: "exactly one question per message" and "must end on the
  // question". The approved wording asks four questions in a row — all about
  // the same thing, which reads as one person taking an interest rather than as
  // a form — and closes on a reassurance instead. Counting question marks was
  // never a measure of whether something reads like a form; what actually
  // matters is that the message hands the conversation back, so that is what is
  // checked.
  it('ships both renderings of the message', () => {
    expect(renderings(onboarding())).toHaveLength(2);
  });

  it('asks the person something in every rendering', () => {
    for (const rendering of renderings(onboarding())) {
      expect(rendering).toMatch(/[?？]/);
    }
  });

  it('keeps each rendering to something a person will actually read', () => {
    for (const rendering of renderings(onboarding())) {
      expect(rendering.length).toBeLessThan(1500);
    }
  });

  it('puts no filesystem paths or shell commands in front of the customer', () => {
    for (const rendering of renderings(onboarding())) {
      expect(rendering).not.toMatch(/~\/yos/);
      expect(rendering).not.toMatch(/`yos /);
    }
  });

  it('keeps the Chinese wording exactly as approved', () => {
    // The Chinese text is the original, not a translation of the English. It
    // was written by hand and approved as written, so it gets its own pin: an
    // agent or a contributor "improving" it by re-translating from the English
    // is the specific loss this prevents.
    expect(onboarding()).toMatch(/send\s+the Chinese one word for word/);
    expect(crypto.createHash('sha256').update(renderings(onboarding())[0]).digest('hex'))
      .toBe('8c7f865415890ad40eb48b613afc680328b2306aee7cf6117c4eb5749b06a74e');
  });
});

describe('what the first conversation points at actually exists', () => {
  it('gives the name a place to live', () => {
    // The agent is told to write the chosen name into a specific heading. If
    // the heading is not in the shipped identity file the instruction dangles,
    // and the name survives only until the session ends — the exact impression
    // asking for a name is meant to avoid.
    expect(onboarding()).toContain('`memory/identity.md` under `## My Name`');
    expect(fs.readFileSync(IDENTITY, 'utf8')).toMatch(/^## My Name$/m);
  });

  it('writes what it learns to a profile the install actually ships', () => {
    expect(onboarding()).toContain('memory/users/<id>/profile.md');
    expect(fs.existsSync(PROFILE)).toBe(true);
  });

  it('tells the agent where the memory it keeps and the credentials it reads live', () => {
    const text = onboarding();
    expect(text).toContain('~/yos/memory/');
    expect(text).toContain('~/yos/.env');
  });

  it('sends the agent to the machine for the capability overview', () => {
    expect(onboarding()).toMatch(/`yos capability list`/);
  });
});

describe('withdrawn claims stay withdrawn', () => {
  it('does not make the customer audit third-party code', () => {
    // The old wording told the customer to "check the source and permissions
    // before enabling them". Reviewing third-party code is the agent's job;
    // asking the customer hands responsibility to someone who cannot discharge
    // it.
    expect(onboarding()).not.toMatch(/check the source and permissions/i);
  });

  it('still carries the impostor disclosure it stopped leading with', () => {
    // Moving a security fact out of the opening message is a judgement call
    // about timing. Deleting it is not, and without this the two look the same
    // in a diff.
    expect(onboarding()).toMatch(/impostor/i);
  });

  it('hands the agent no canned capability example', () => {
    // Both phrases shipped in the old Step 2. The first was false on every
    // machine in this repository; the second is unfalsifiable by construction.
    const text = onboarding();
    expect(text).not.toMatch(/control a browser/i);
    expect(text).not.toMatch(/anything you can think of/i);
  });
});

describe('the first conversation cannot change without a human signing for it', () => {
  it('pins the approved onboarding bytes', () => {
    // Repinned 2026-08-28: replaced the opening with wording written and
    // approved by hand — it tells the person not to study the feature list,
    // says plainly that the agent acts for real and speaks before acting, and
    // spends its last third asking about them. Chinese ships verbatim with its
    // own pin; English carries the same message for every other language. The
    // paths, the stop command and the impostor disclosure remain
    // answer-on-request notes.
    //
    // Prose cannot be verified by test. This pin is the substitute: any edit
    // fails here until someone updates the hash on purpose, which is the point
    // at which the new wording gets read by a human.
    const expected = 'd8ec5367ca33161b42aeb957c02af8f1a5c19fadfa11c1c5de0c79d1a44839b3';
    expect(crypto.createHash('sha256').update(onboarding()).digest('hex')).toBe(expected);
  });
});
