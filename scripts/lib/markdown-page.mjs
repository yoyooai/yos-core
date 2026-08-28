/**
 * Render the version catalog into a page a browser lays out properly.
 *
 * The catalog used to reach the browser as its own markdown source, escaped and
 * dropped inside a single <pre>. That was a deliberate trade: the page must open
 * on a machine that cannot reach the internet, so it may not pull a markdown
 * library, a stylesheet or a font from anywhere. The trade was mispriced —
 * "no external dependency" does not require "renders as a wall of pipes and
 * asterisks". Rendering happens here, at build time, in the same process that
 * writes the mirror. The shipped page is still one self-contained file with zero
 * fetches, and it is still generated from index.json, so it still cannot
 * disagree with the goods.
 *
 * The subset is small ON PURPOSE, and anything outside it throws instead of
 * degrading. A renderer that silently passes through what it does not
 * understand is the same failure mode as a hand-kept table: it keeps looking
 * confident while quietly going wrong. If a future catalog line needs a
 * construct that is not here, the build stops and says so — teach the renderer,
 * do not let the page fall back to unrendered text.
 *
 * Supported: headings, paragraphs, "- " lists, pipe tables (with alignment),
 * **bold**, _italic_, ~~strike~~, `code`.
 */

export class UnsupportedMarkdown extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedMarkdown';
  }
}

/**
 * Placeholder for extracted code spans. A NUL byte cannot occur in the catalog
 * markdown, so it cannot collide with real content — and it is constructed here
 * rather than typed as a literal, which would make this file read as binary to
 * grep and diff.
 */
const NUL = String.fromCharCode(0);

/** CJK ideographs, kana, and full-width/CJK punctuation. */
const CJK = new RegExp('[\\u2E80-\\u9FFF\\uF900-\\uFAFF\\uFE30-\\uFE4F\\uFF00-\\uFFEF]');

const SUBSET = 'headings, paragraphs, "- " lists, pipe tables, **bold**, '
  + '_italic_, ~~strike~~, `code`';

function fail(what, line) {
  throw new UnsupportedMarkdown(
    `${what}. The catalog page is rendered by a deliberately small markdown `
    + `subset (${SUBSET}), and anything outside it stops the build rather than `
    + 'reaching the shelf unrendered. Repair: reword the source line in '
    + 'scripts/lib/dist-catalog.mjs, or teach scripts/lib/markdown-page.mjs the '
    + `construct. Offending line: ${JSON.stringify(line)}`);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Characters that mean something to this renderer and can be backslash-escaped. */
export const ESCAPABLE = '\\`*_~|[]<>';

/**
 * Inline constructs. Two kinds of text are pulled out before anything is parsed
 * and put back after everything is: code spans, whose content is literal (a pipe
 * or an asterisk inside `curl … | bash` is not markup), and backslash escapes,
 * which is how free-text data reaches this page without being read as markup —
 * see escapeMarkdownText in dist-catalog.mjs. A withdrawal reason mentioning
 * node_modules must render as node_modules, not open an italic run.
 */
export function renderInline(text, line = text) {
  const source = String(text);
  if (source.includes(NUL)) fail('NUL byte in markdown source', line);

  // One left-to-right pass, so whichever comes first wins: a backslash can
  // escape a backtick, and a backslash inside a code span stays a backslash.
  // Extracting either kind first would corrupt the other.
  const codes = [];
  const literals = [];
  let work = '';
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      const escaped = source[cursor + 1];
      if (!escaped || !ESCAPABLE.includes(escaped)) {
        fail(`backslash escape outside ${JSON.stringify(ESCAPABLE)}`, line);
      }
      work += `${NUL}L${literals.push(escaped) - 1}${NUL}`;
      cursor += 2;
      continue;
    }
    if (char === '`') {
      const end = source.indexOf('`', cursor + 1);
      if (end === -1) fail('unbalanced backtick', line);
      work += `${NUL}C${codes.push(source.slice(cursor + 1, end)) - 1}${NUL}`;
      cursor = end + 1;
      continue;
    }
    work += char;
    cursor += 1;
  }
  if (/!\[|\]\(/.test(work)) fail('links and images are not supported', line);

  work = escapeHtml(work);
  work = work.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  work = work.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  work = work.replace(/(^|[^A-Za-z0-9])_([^_]+)_(?=$|[^A-Za-z0-9])/g, '$1<em>$2</em>');

  // Leftover emphasis punctuation means the patterns above did not match what
  // the author meant. Rendering it literally would put raw markdown on the shelf.
  if (work.includes('*')) fail('unbalanced **bold** (a single * is not supported)', line);
  if (work.includes('~')) fail('unbalanced ~~strike~~', line);
  if (work.includes('_')) fail('unbalanced _italic_', line);

  return work.replace(
    new RegExp(`${NUL}([CL])(\\d+)${NUL}`, 'g'),
    (_match, kind, index) => (kind === 'C'
      ? `<code>${escapeHtml(codes[Number(index)])}</code>`
      : escapeHtml(literals[Number(index)])));
}

/**
 * Markdown folds a paragraph's lines into one. A space is right between latin
 * words and wrong between Chinese sentences, and this catalog is mostly the
 * latter, so the separator follows the characters actually meeting.
 */
function softJoin(previous, next) {
  const left = previous.slice(-1);
  const right = next.slice(0, 1);
  return CJK.test(left) || CJK.test(right) ? '' : ' ';
}

function isTableDelimiter(line) {
  return /^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim());
}

/** Cells of one pipe row. `\|` is an escaped pipe inside a cell, not a border. */
function splitRow(line) {
  return line.trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, '|'));
}

function alignmentOf(delimiterCell) {
  const cell = delimiterCell.trim();
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

function cellHtml(tag, text, align, line) {
  const style = align ? ` style="text-align:${align}"` : '';
  return `<${tag}${style}>${renderInline(text, line)}</${tag}>`;
}

/** Reject what this renderer does not do, before anything is emitted. */
function rejectUnsupportedBlock(line) {
  if (/^(?:\t| {4,})\S/.test(line)) fail('indented block (nested list or indented code)', line);
  if (/^\s+\S/.test(line)) fail('unexpected leading whitespace', line);
  if (/^(?:```|~~~)/.test(line)) fail('fenced code block', line);
  if (/^>/.test(line)) fail('blockquote', line);
  if (/^\d+[.)]\s/.test(line)) fail('ordered list', line);
  if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) fail('thematic break', line);
  if (/^(?:\*|\+)\s/.test(line)) fail('list marker other than "- "', line);
}

/**
 * @param {string} markdown
 * @returns {string} body HTML, no wrapper element
 */
export function renderMarkdownBody(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    rejectUnsupportedBlock(line);

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim(), line)}</h${level}>`);
      index += 1;
      continue;
    }

    if (line.startsWith('|')) {
      const delimiter = lines[index + 1];
      if (!delimiter || !isTableDelimiter(delimiter)) {
        fail('table header without a |---|---| delimiter row', line);
      }
      const headers = splitRow(line);
      const aligns = splitRow(delimiter).map(alignmentOf);
      if (aligns.length !== headers.length) {
        fail(`table delimiter has ${aligns.length} cells, header has ${headers.length}`, line);
      }
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].startsWith('|')) {
        if (isTableDelimiter(lines[index])) fail('second delimiter row inside a table', lines[index]);
        const cells = splitRow(lines[index]);
        // A row with the wrong cell count is the shredded-row defect the pipe
        // escaping in dist-catalog.mjs exists to prevent. Do not paper over it.
        if (cells.length !== headers.length) {
          fail(`table row has ${cells.length} cells, header has ${headers.length}`, lines[index]);
        }
        rows.push({ cells, line: lines[index] });
        index += 1;
      }
      const head = headers.map((text, i) => cellHtml('th', text, aligns[i], line)).join('');
      const body = rows
        .map(row => `<tr>${row.cells.map((text, i) => cellHtml('td', text, aligns[i], row.line)).join('')}</tr>`)
        .join('');
      // Wide tables scroll inside their own box; the page itself never does.
      out.push(`<div class="table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    if (/^-\s/.test(line)) {
      const items = [];
      while (index < lines.length && lines[index].trim() !== '') {
        const item = lines[index];
        if (!/^-\s/.test(item)) fail('lazy continuation line inside a list', item);
        rejectUnsupportedBlock(item);
        items.push(`<li>${renderInline(item.replace(/^-\s+/, ''), item)}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== '') {
      const current = lines[index];
      if (/^(?:#{1,6}\s|\||-\s)/.test(current) && paragraph.length > 0) break;
      rejectUnsupportedBlock(current);
      paragraph.push(current.trim());
      index += 1;
    }
    const text = paragraph.reduce((acc, part) => (acc ? acc + softJoin(acc, part) + part : part), '');
    out.push(`<p>${renderInline(text, paragraph.join('\n'))}</p>`);
  }

  return out.join('\n');
}

/**
 * Every rule is inline: the page has to render identically on a machine with no
 * route to the internet, so there is nothing to fetch — no stylesheet, no font
 * file, no script. System fonts only, and both colour schemes, because the
 * reader's theme is not ours to choose.
 */
const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #1c1f23;
  --muted: #5c6570;
  --rule: #e3e6ea;
  --rule-strong: #cfd4da;
  --chip-bg: #f2f4f7;
  --chip-fg: #1a3b6b;
  --head-bg: #f7f8fa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a;
    --fg: #e6e9ec;
    --muted: #9aa4af;
    --rule: #272c31;
    --rule-strong: #3a4148;
    --chip-bg: #1e2429;
    --chip-fg: #9ec5ff;
    --head-bg: #1a1f24;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 3rem 1.25rem 5rem;
  max-width: 54rem;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-text-size-adjust: 100%;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3; font-weight: 650; }
h1 {
  margin: 0 0 1.5rem;
  padding-bottom: .75rem;
  border-bottom: 2px solid var(--rule-strong);
  font-size: 1.75rem;
  letter-spacing: -.01em;
}
h2 {
  margin: 2.75rem 0 1rem;
  padding-bottom: .4rem;
  border-bottom: 1px solid var(--rule);
  font-size: 1.3rem;
}
h3 { margin: 2rem 0 .6rem; font-size: 1.08rem; }
p { margin: 0 0 1rem; }
strong { font-weight: 650; }
em { color: var(--muted); font-style: normal; font-size: .9em; }
del { color: var(--muted); }
code {
  padding: .12em .38em;
  border-radius: 5px;
  background: var(--chip-bg);
  color: var(--chip-fg);
  font: .875em/1.5 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
        "Liberation Mono", monospace;
  word-break: break-word;
}
del code { color: var(--muted); text-decoration: line-through; }
ul { margin: 0 0 1rem; padding-left: 1.35rem; }
li { margin: .3rem 0; }
li::marker { color: var(--muted); }
.table-scroll {
  margin: 0 0 1.25rem;
  overflow-x: auto;
  border: 1px solid var(--rule);
  border-radius: 8px;
}
table { width: 100%; border-collapse: collapse; font-size: .95rem; }
th, td {
  padding: .6rem .8rem;
  border-bottom: 1px solid var(--rule);
  text-align: left;
  vertical-align: top;
}
thead th {
  background: var(--head-bg);
  font-weight: 650;
  white-space: nowrap;
}
tbody tr:last-child td { border-bottom: 0; }
td code { white-space: pre; }
`.trim();

/**
 * @param {string} markdown
 * @param {object} [options]
 * @param {string} [options.title] document title
 * @returns {string} one self-contained HTML document
 */
export function renderMarkdownPage(markdown, { title = 'YOS' } = {}) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${STYLE}
</style>
</head>
<body>
${renderMarkdownBody(markdown)}
</body>
</html>
`;
}
