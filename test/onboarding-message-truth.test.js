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
 *   - Turning the meeting back into a form. Checked here: one question per
 *     message, ending on that question, short enough to read on a phone.
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
 * The customer-facing messages: each run of consecutive blockquote lines is one
 * message the user receives, so they are checked one at a time rather than as
 * one blob. A rule about "one question per message" is meaningless otherwise.
 */
function customerMessages(text) {
  const messages = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      current ??= [];
      current.push(line.slice(1).trim());
    } else if (current) {
      messages.push(current.join('\n').trim());
      current = null;
    }
  }
  if (current) messages.push(current.join('\n').trim());
  return messages;
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

describe('the first conversation stays a conversation', () => {
  // Successive drafts of this file failed in both directions: one recited four
  // warnings at a stranger, another put filesystem paths and `yos stop` into
  // the opening message. Both were accurate and neither was readable. The
  // details still ship, as notes the agent answers with on request.
  it('scripts more than one message', () => {
    expect(customerMessages(onboarding()).length).toBeGreaterThanOrEqual(2);
  });

  it('asks exactly one question per message, and ends on it', () => {
    for (const message of customerMessages(onboarding())) {
      expect([...message].filter(character => character === '?')).toHaveLength(1);
      expect(message.endsWith('?')).toBe(true);
    }
  });

  it('keeps each message to something a person will actually read', () => {
    for (const message of customerMessages(onboarding())) {
      expect(message.length).toBeLessThan(700);
    }
  });

  it('puts no filesystem paths or shell commands in front of the customer', () => {
    for (const message of customerMessages(onboarding())) {
      expect(message).not.toMatch(/~\/yos/);
      expect(message).not.toMatch(/`yos /);
    }
  });

  it('opens by asking what to be called', () => {
    expect(customerMessages(onboarding())[0]).toMatch(/call me\?$/);
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
    // Repinned 2026-08-28: restructured from a single announcement into three
    // beats — introduce yourself and ask what to be called, say what this
    // machine can do and ask what takes up their time, then finish one real
    // piece of work while writing down what you learn. The paths, the stop
    // command and the impostor disclosure remain as answer-on-request notes.
    //
    // Prose cannot be verified by test. This pin is the substitute: any edit
    // fails here until someone updates the hash on purpose, which is the point
    // at which the new wording gets read by a human.
    const expected = '8ab0446f67798a75fd5622011218011f6bd44a93349c446969c4085706764fb8';
    expect(crypto.createHash('sha256').update(onboarding()).digest('hex')).toBe(expected);
  });
});
