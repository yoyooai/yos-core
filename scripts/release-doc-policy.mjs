/**
 * Keep the release runbook's commands runnable.
 *
 * `docs/release.md` is the only step-by-step source for shipping to the
 * production shelf, and its defects do not look like defects — they look like a
 * command that expands to something slightly wrong. The one that got through
 * twice in 2026-08-11's review was the same shape both times: a block of
 * commands that runs on one machine, using a variable that only ever had a value
 * on a different one. `--root $BAK` on the control machine expands to `--root `
 * and the operator is left reading an error about a missing argument, at the
 * moment they were trying to secure a shelf.
 *
 * Prose cannot enforce this — the first version said "this step spans two
 * machines" one paragraph above the block that broke it. So every command block
 * declares its machine in a `# @machine <name>` first line, and this module
 * checks that each variable a block reads was assigned earlier *on that same
 * machine*.
 *
 * What this deliberately does NOT do is understand shell. It is a closure check
 * over assignments and expansions, nothing more: it cannot tell whether a
 * command is correct, only whether the values it names could exist where it
 * runs.
 */

/** Names the shell or the environment supplies; a block need not assign them. */
const AMBIENT = new Set([
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TERM',
  'EDITOR',
  'IFS',
  'HOSTNAME',
]);

const FENCE = /^```bash\s*$/;
const MACHINE_TAG = /^#\s*@machine\s+(\S+)\s*$/;

/**
 * Every fenced bash block, in document order, with the machine it declares.
 * A block without the tag is returned with `machine: null` — the caller reports
 * it, rather than this silently treating untagged blocks as belonging nowhere.
 */
export function extractCommandBlocks(markdown) {
  const lines = markdown.split('\n');
  const blocks = [];
  let current = null;

  lines.forEach((line, index) => {
    if (current) {
      if (/^```\s*$/.test(line)) {
        blocks.push(current);
        current = null;
        return;
      }
      current.lines.push({ text: line, line: index + 1 });
      return;
    }
    if (FENCE.test(line)) current = { machine: null, startLine: index + 1, lines: [] };
  });

  for (const block of blocks) {
    const first = block.lines.find((l) => l.text.trim() !== '');
    const match = first && MACHINE_TAG.exec(first.text.trim());
    if (match) block.machine = match[1];
  }
  return blocks;
}

/**
 * Names this line binds. `export A=1 B=2` binds both; `STAMP=$(date …)` binds
 * one and the value is left alone (it may contain spaces, quotes, anything).
 */
export function assignmentsIn(text) {
  const trimmed = text.trim();
  if (/^export\s+/.test(trimmed)) {
    return trimmed
      .replace(/^export\s+/, '')
      .split(/\s+/)
      .map((token) => /^([A-Za-z_]\w*)=/.exec(token)?.[1])
      .filter(Boolean);
  }
  const direct = /^([A-Za-z_]\w*)=/.exec(trimmed);
  if (direct) return [direct[1]];
  const loop = /^for\s+([A-Za-z_]\w*)\s+in\s/.exec(trimmed);
  if (loop) return [loop[1]];
  const read = /^read\s+(?:-r\s+)?([A-Za-z_]\w*)/.exec(trimmed);
  if (read) return [read[1]];
  return [];
}

/**
 * Walk a block the way the shell reads it, tracking quote state across lines,
 * and return per line the code that actually runs plus the names it expands.
 *
 * Approximating this with one regex per line was wrong in both directions on
 * the first attempt: it flagged `$STAMP` inside a `#` comment (never expanded)
 * and `${s.buildId}` inside a single-quoted `node -e '…'` (that is JavaScript,
 * and single quotes are exactly how it stays JavaScript). A checker that cries
 * wolf gets its findings waved through, so it has to be right about which text
 * the shell would even look at.
 *
 * `\$FOO` is skipped on purpose: in an unquoted heredoc that escape means "do
 * not expand here" — it is a value for the far side of an ssh, not a read on
 * this one.
 */
export function scanBlock(lines) {
  let state = 'none'; // none | single | double
  return lines.map(({ text, line }) => {
    let code = '';
    const expansions = [];

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];

      if (state === 'single') {
        if (char === "'") state = 'none';
        code += ' ';
        continue;
      }

      if (char === '\\' && state !== 'single') {
        code += ' ';
        i += 1; // the escaped character is literal, including an escaped `$`
        if (i < text.length) code += ' ';
        continue;
      }

      if (state === 'double') {
        if (char === '"') {
          state = 'none';
          code += char;
          continue;
        }
      } else {
        if (char === "'") {
          state = 'single';
          code += ' ';
          continue;
        }
        if (char === '"') {
          state = 'double';
          code += char;
          continue;
        }
        // A `#` at a token boundary starts a comment: the rest of the line is
        // never run, so nothing in it is a read or an assignment.
        if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) break;
      }

      if (char === '$') {
        const name = /^\$\{?([A-Za-z_]\w*)/.exec(text.slice(i))?.[1];
        if (name) expansions.push(name);
      }
      code += char;
    }

    return { line, code, expansions };
  });
}

/**
 * Reads that no earlier line on the same machine could have bound.
 *
 * Order matters within a block as well as across blocks: a variable used above
 * its own assignment is just as empty as one that belongs to another machine.
 */
export function checkVariableClosure(blocks) {
  const problems = [];
  const boundPerMachine = new Map();

  blocks.forEach((block, blockIndex) => {
    if (!block.machine) {
      problems.push({
        line: block.startLine,
        kind: 'untagged',
        message:
          `command block #${blockIndex + 1} has no "# @machine <name>" first line — ` +
          'a block that does not say where it runs cannot be checked, and this runbook ' +
          'has already shipped one that ran in the wrong place',
      });
      return;
    }
    if (!boundPerMachine.has(block.machine)) boundPerMachine.set(block.machine, new Set());
    const bound = boundPerMachine.get(block.machine);

    for (const { line, code, expansions } of scanBlock(block.lines)) {
      for (const name of expansions) {
        if (bound.has(name) || AMBIENT.has(name)) continue;
        problems.push({
          line,
          kind: 'unbound',
          machine: block.machine,
          name,
          message:
            `$${name} is read on 【${block.machine}】 but never assigned there. ` +
            'If it belongs to another machine, the runbook has to carry it across ' +
            'explicitly — shell variables do not cross an ssh.',
        });
      }
      for (const name of assignmentsIn(code)) bound.add(name);
    }
  });

  return problems;
}

export function verifyReleaseDoc(markdown) {
  const blocks = extractCommandBlocks(markdown);
  if (blocks.length === 0) throw new Error('docs/release.md has no bash command blocks to check');
  return { blocks, problems: checkVariableClosure(blocks) };
}
