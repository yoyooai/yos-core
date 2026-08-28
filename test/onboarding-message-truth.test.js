import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ONBOARDING = path.join(ROOT, 'templates', 'onboarding.md');
const CLI = path.join(ROOT, 'cli', 'yos.js');

const onboarding = () => fs.readFileSync(ONBOARDING, 'utf8');

/**
 * Why this file exists.
 *
 * templates/onboarding.md holds the first message a customer ever receives: a
 * security disclosure and, if they opened with a greeting, an introduction to
 * what this machine can do. It shipped for months claiming the agent could
 * "control a browser to scrape data" — no such capability exists in this
 * repository — and telling the customer to review third-party source code
 * themselves, which is the agent's job and not something a customer can do.
 *
 * Two failure modes, and only one of them is machine-checkable:
 *
 *   - Naming a command that does not exist. Checked here against the CLI's own
 *     command table, the same shape as the install-time guard that requires
 *     every tool the manual names to actually be installed.
 *   - Promising a capability in prose. NOT checkable — no test can tell whether
 *     "I can control a browser" is true. That is why the file is byte-pinned
 *     instead: an edit cannot land without a human consciously re-signing it.
 *
 * The string-absence assertions below are deliberately narrow. They stop these
 * two specific claims from being reintroduced; they do not and cannot detect a
 * newly invented one.
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

describe('the first message names only commands that exist', () => {
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

/** The customer-facing notice: the blockquoted lines, without the marker. */
function customerNotice(text) {
  return text.split('\n').filter(line => line.startsWith('>')).map(line => line.slice(1).trim()).join('\n');
}

describe('the customer notice stays readable', () => {
  // The disclosure is the first thing a stranger reads, usually on a phone. An
  // earlier draft of this rewrite put the memory path, the credentials path and
  // `yos stop` straight into it and read as a configuration manual — accurate
  // and useless. The paths still ship, as notes the agent answers with on
  // request; they just do not land on first contact.
  it('quotes a notice at all', () => {
    expect(customerNotice(onboarding()).split('\n').length).toBeGreaterThan(4);
  });

  it('puts no filesystem paths or shell commands in front of the customer', () => {
    const notice = customerNotice(onboarding());
    expect(notice).not.toMatch(/~\/yos/);
    expect(notice).not.toMatch(/`yos /);
  });

  it('keeps it to something a person will actually read', () => {
    expect(customerNotice(onboarding()).length).toBeLessThan(900);
  });
});

describe('the file still knows the details it no longer leads with', () => {
  it('tells the agent where the memory it keeps and the credentials it reads live', () => {
    const text = onboarding();
    expect(text).toContain('~/yos/memory/');
    expect(text).toContain('~/yos/.env');
  });

  it('does not make the customer audit third-party code', () => {
    // Reintroduction guard for the old wording, which told the customer to
    // "check the source and permissions before enabling them". Reviewing
    // third-party code is the agent's job; asking the customer to do it hands
    // responsibility to someone who cannot discharge it.
    expect(onboarding()).not.toMatch(/check the source and permissions/i);
  });

  it('hands the agent no canned capability example', () => {
    // Both phrases shipped in Step 2. The first was false on every machine in
    // this repository; the second is unfalsifiable by construction.
    const text = onboarding();
    expect(text).not.toMatch(/control a browser/i);
    expect(text).not.toMatch(/anything you can think of/i);
  });

  it('sends the agent to the machine for the capability overview', () => {
    expect(onboarding()).toMatch(/`yos capability list`/);
  });
});

describe('the first message cannot change without a human signing for it', () => {
  it('pins the approved onboarding bytes', () => {
    // Repinned 2026-08-28: rewrote the security notice from four warnings aimed
    // at the customer into three plain-language disclosures, moved the paths
    // and commands out of it into answer-on-request notes for the agent, and
    // replaced the Step 2 capability example with an instruction to read the
    // capability list off the machine.
    //
    // Prose cannot be verified by test. This pin is the substitute: any edit
    // fails here until someone updates the hash on purpose, which is the point
    // at which the new wording gets read by a human.
    const expected = '01c656d42e425c33f39cba00d1cf4ef48c3f6036a60c60fac779117b1a4f217f';
    expect(crypto.createHash('sha256').update(onboarding()).digest('hex')).toBe(expected);
  });
});
