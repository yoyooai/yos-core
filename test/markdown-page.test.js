/**
 * The catalog page must be laid out, and must stay laid out.
 *
 * It used to ship as its own markdown source inside one <pre> — correct content,
 * unreadable presentation. Rendering it means the page now has a parser between
 * the data and the reader, and a parser is a new way to go quietly wrong:
 *
 *   1. it could pass through what it does not understand, putting raw markdown
 *      on the shelf while every test still passes — so anything outside the
 *      supported subset throws, and the whole real catalog is rendered here to
 *      prove no leftover syntax reaches the body;
 *   2. it could read data as markup — a withdrawal reason mentioning
 *      node_modules opened an italic run the first time this ran against the
 *      real mirror, which is why free text is escaped at the interpolation;
 *   3. it could shred a table row, the exact defect the pipe escaping in
 *      dist-catalog.mjs exists to prevent, so a wrong cell count is an error
 *      rather than a row that silently loses its install command;
 *   4. it could re-render the page as HTML it was handed, so code spans and
 *      text are escaped and a raw tag can never become live markup.
 */

import { describe, expect, test } from '@jest/globals';
import {
  ESCAPABLE,
  UnsupportedMarkdown,
  renderInline,
  renderMarkdownBody,
  renderMarkdownPage,
} from '../scripts/lib/markdown-page.mjs';

/** Every block construct the catalog generator actually emits. */
const CATALOG_SHAPED = `# YOS 版本目录

**这里是唯一源头。** 版本看这一张表。

这张表不是手写的 —— 数据来自 \`index.json\`。
所以它不可能和实际货架说的不一样。

_源码基准时间：2026-08-28T21:26:28+08:00_

## 最新版本

| 组件 | 最新版本 | 怎么装 |
|---|---|---|
| **YOS OS 主体** | \`0.1.24\` | \`curl -fsSL https://example.test/install.sh \\| bash\` |

### YOS OS 主体

YOS 本体（CLI、服务、技能）

- 源码正本（备胎）：\`yoyooai/yos-core\`
- 镜像留存 2 个版本：\`0.1.24\` ~~\`0.1.22\`~~（已撤回）
- 每个版本都能离线装回
`;

describe('the supported subset renders as elements, not as text', () => {
  const body = renderMarkdownBody(CATALOG_SHAPED);

  test('headings, table, list and emphasis all become markup', () => {
    expect(body).toContain('<h1>YOS 版本目录</h1>');
    expect(body).toContain('<h2>最新版本</h2>');
    expect(body).toContain('<h3>YOS OS 主体</h3>');
    expect(body).toContain('<table>');
    expect(body).toContain('<th>组件</th>');
    expect(body).toContain('<ul>');
    expect(body).toContain('<li>');
    expect(body).toContain('<strong>这里是唯一源头。</strong>');
    expect(body).toContain('<em>源码基准时间：2026-08-28T21:26:28+08:00</em>');
    expect(body).toContain('<del><code>0.1.22</code></del>');
    expect(body).toContain('<code>index.json</code>');
  });

  /**
   * The regression that matters. If the renderer is reverted to a <pre> dump, or
   * a construct starts falling through, raw syntax appears in the body and this
   * fails — the page cannot quietly go back to looking like source.
   */
  test('no raw markdown syntax survives into the body', () => {
    expect(body).not.toMatch(/\*\*/);
    expect(body).not.toMatch(/~~/);
    expect(body).not.toMatch(/`/);
    expect(body).not.toMatch(/\|---/);
    expect(body).not.toMatch(/^#{1,6} /m);
    expect(body).not.toMatch(/^- /m);
    expect(body).not.toMatch(/\\/);
    expect(body).not.toContain('<pre>');
  });

  test('a paragraph folds its lines the way the script reads them', () => {
    // A space between latin words, nothing between Chinese sentences.
    expect(body).toContain('。所以它不可能');
    expect(renderMarkdownBody('alpha\nbeta')).toContain('<p>alpha beta</p>');
  });
});

describe('data is data, never markup', () => {
  test('an escaped character renders literally', () => {
    // What escapeMarkdownText in dist-catalog.mjs produces for real reasons.
    expect(renderInline('ships no node\\_modules')).toBe('ships no node_modules');
    expect(renderInline('literal \\*\\*not bold\\*\\*')).toBe('literal **not bold**');
    expect(renderInline('a \\| b')).toBe('a | b');
  });

  test('every escapable character round-trips', () => {
    for (const char of ESCAPABLE) {
      expect(renderInline(`x\\${char}y`)).toBe(`x${char === '<' ? '&lt;' : char === '>' ? '&gt;' : char}y`);
    }
  });

  test('an unknown escape stops the build rather than printing a backslash', () => {
    expect(() => renderInline('C:\\path')).toThrow(UnsupportedMarkdown);
  });
});

describe('code spans are literal', () => {
  test('a pipe inside a command is not a cell border', () => {
    const body = renderMarkdownBody(CATALOG_SHAPED);
    expect(body).toContain('<code>curl -fsSL https://example.test/install.sh | bash</code>');
  });

  test('markdown and HTML inside a code span are left alone', () => {
    expect(renderInline('`install-v<tag>.sh`')).toBe('<code>install-v&lt;tag&gt;.sh</code>');
    expect(renderInline('`a **b** _c_`')).toBe('<code>a **b** _c_</code>');
  });

  test('a raw tag in prose cannot become live markup', () => {
    expect(renderInline('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('an unbalanced backtick is an error, not a stray tick on the page', () => {
    expect(() => renderInline('`oops')).toThrow(UnsupportedMarkdown);
  });
});

describe('anything outside the subset stops the build', () => {
  const rejected = {
    link: '[docs](https://example.test)',
    image: '![alt](https://example.test/x.png)',
    blockquote: '> quoted',
    'fenced code': '```sh\necho hi\n```',
    'ordered list': '1. first',
    'thematic break': '---',
    'other list marker': '* item',
    'indented block': '    indented',
    'unbalanced bold': '**open only',
    'single asterisk': 'a * b',
    'unbalanced strike': '~~open only',
  };

  for (const [name, markdown] of Object.entries(rejected)) {
    test(`${name} throws`, () => {
      expect(() => renderMarkdownBody(markdown)).toThrow(UnsupportedMarkdown);
    });
  }

  test('the error names the offending line and what to do', () => {
    let error;
    try {
      renderMarkdownBody('> quoted');
    } catch (caught) {
      error = caught;
    }
    expect(error.message).toContain('blockquote');
    expect(error.message).toContain('markdown-page.mjs');
    expect(error.message).toContain('"> quoted"');
  });
});

describe('a table keeps every cell it was given', () => {
  test('a row with the wrong cell count is an error, not a shredded row', () => {
    const short = '| a | b |\n|---|---|\n| only-one |';
    expect(() => renderMarkdownBody(short)).toThrow(/table row has 1 cells/);
  });

  test('a header with no delimiter row is an error', () => {
    expect(() => renderMarkdownBody('| a | b |\ntext')).toThrow(/delimiter row/);
  });

  test('alignment is honoured rather than silently dropped', () => {
    const body = renderMarkdownBody('| l | c | r |\n|:--|:-:|--:|\n| 1 | 2 | 3 |');
    expect(body).toContain('<th style="text-align:left">l</th>');
    expect(body).toContain('<th style="text-align:center">c</th>');
    expect(body).toContain('<th style="text-align:right">r</th>');
  });

  test('wide tables scroll in their own box, so the page never does', () => {
    expect(renderMarkdownBody('| a |\n|---|\n| 1 |'))
      .toContain('<div class="table-scroll">');
  });
});

describe('the page is self-contained', () => {
  const page = renderMarkdownPage(CATALOG_SHAPED, { title: 'YOS 版本目录' });

  /**
   * The original reason for the <pre>: this page has to open on a machine with
   * no route to the internet. Prettier presentation may not cost that.
   */
  test('nothing is fetched — no script, no external stylesheet, font or image', () => {
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/<link/i);
    expect(page).not.toMatch(/@import/i);
    expect(page).not.toMatch(/https?:\/\/[^"'\s]*\.(?:css|js|woff2?|ttf|png|jpg|svg)/i);
    expect(page).not.toMatch(/url\(/i);
  });

  test('it declares its title, charset, viewport and both colour schemes', () => {
    expect(page).toContain('<title>YOS 版本目录</title>');
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('name="viewport"');
    expect(page).toContain('color-scheme: light dark');
    expect(page).toContain('prefers-color-scheme: dark');
  });
});
