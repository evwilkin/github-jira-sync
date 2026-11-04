/**
 * Tests for Markdown ↔ ADF (Atlassian Document Format) conversion helpers.
 *
 * These functions are not exported from helpers.js, so we extract them from the
 * source and eval them into scope. This is a temporary approach until the module
 * is refactored for testability.
 *
 * Run: node tests/adf-conversion.test.mjs
 */
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, '../src/helpers.js'), 'utf-8');

// Extract a top-level function from the source by name
function extractFn(name) {
  const re = new RegExp(`^function ${name}\\b[\\s\\S]*?\\n\\}`, 'm');
  const match = src.match(re);
  if (!match) throw new Error(`Could not find function ${name}`);
  return match[0];
}

const fnNames = [
  'adfNodeType',
  'adfInlineToMarkdown',
  'taskItemContentToMarkdown',
  'adfBlocksToMarkdown',
  'parseMarkdownInline',
  'markdownToADFBlocks',
];

const allCode = fnNames.map((n) => extractFn(n)).join('\n\n');

// Build a runner that defines all helpers in a shared scope
// randomUUID is injected via `this` since Function constructor has no module scope
function buildRunner(testBody) {
  return new Function(`const randomUUID = this.randomUUID;\n${allCode}\n\n${testBody}`);
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

// ─── Nested Checkboxes: GitHub → Jira ────────────────────────────────────────

console.log('\n=== Nested Checkboxes: GitHub → Jira ===');

buildRunner(`
  const md = '- [ ] Top level task\\n- [x] Completed task\\n  - [ ] Nested subtask\\n  - [x] Done subtask\\n    - [ ] Double nested\\n- [ ] Another top level';
  const blocks = markdownToADFBlocks(md);
  const root = blocks[0];

  this.assert(root.type === 'taskList', 'produces a taskList root node');
  this.assert(root.content.length === 4, 'root has 4 children (2 items + 1 nested list + 1 item)');
  this.assert(root.content[0].type === 'taskItem', 'first child is a taskItem');
  this.assert(root.content[0].attrs.state === 'TODO', 'first item is TODO');
  this.assert(root.content[1].attrs.state === 'DONE', 'second item is DONE');

  const nestedList = root.content[2];
  this.assert(nestedList.type === 'taskList', 'third child is a nested taskList');
  this.assert(nestedList.content[0].attrs.state === 'TODO', 'nested item 1 is TODO');
  this.assert(nestedList.content[1].attrs.state === 'DONE', 'nested item 2 is DONE');

  const doubleNested = nestedList.content[2];
  this.assert(doubleNested.type === 'taskList', 'double-nested taskList exists');
  this.assert(doubleNested.content[0].content[0].text === 'Double nested', 'double-nested text correct');

  this.assert(root.content[3].content[0].text === 'Another top level', 'last top-level item text correct');
`).call({ assert, randomUUID });

// ─── Nested Checkboxes: UUID localIds ────────────────────────────────────────

console.log('\n=== Nested Checkboxes: UUID localIds ===');

buildRunner(`
  const md = '- [ ] Top\\n  - [ ] Nested';
  const blocks = markdownToADFBlocks(md);
  const root = blocks[0];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  this.assert(uuidRegex.test(root.attrs.localId), 'root taskList has UUID localId: ' + root.attrs.localId);
  this.assert(uuidRegex.test(root.content[0].attrs.localId), 'taskItem has UUID localId: ' + root.content[0].attrs.localId);

  const nestedList = root.content[1];
  this.assert(uuidRegex.test(nestedList.attrs.localId), 'nested taskList has UUID localId: ' + nestedList.attrs.localId);
  this.assert(nestedList.attrs.localId !== root.attrs.localId, 'nested list localId differs from root');
`).call({ assert, randomUUID });

// ─── Nested Checkboxes: Jira → GitHub (round-trip) ──────────────────────────

console.log('\n=== Nested Checkboxes: Jira → GitHub (round-trip) ===');

buildRunner(`
  const md = '- [ ] Top level\\n  - [ ] Nested\\n    - [x] Deep nested\\n- [x] Done';
  const blocks = markdownToADFBlocks(md);
  const reversed = adfBlocksToMarkdown(blocks);
  const lines = reversed.split('\\n').filter(l => l.trim());

  this.assert(lines[0] === '- [ ] Top level', 'top-level preserved: ' + JSON.stringify(lines[0]));
  this.assert(lines[1] === '  - [ ] Nested', 'indent preserved: ' + JSON.stringify(lines[1]));
  this.assert(lines[2] === '    - [x] Deep nested', 'deep indent preserved: ' + JSON.stringify(lines[2]));
  this.assert(lines[3] === '- [x] Done', 'back to top level: ' + JSON.stringify(lines[3]));
`).call({ assert, randomUUID });

// ─── HTML <img> tag: GitHub → Jira ──────────────────────────────────────────

console.log('\n=== HTML <img> tag: GitHub → Jira ===');

buildRunner(`
  const md = '<img width="2347" height="1149" alt="Image" src="https://github.com/user-attachments/assets/example.png" />';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'mediaSingle', 'block is mediaSingle');
  this.assert(blocks[0].content[0].type === 'media', 'child is media node');
  this.assert(blocks[0].content[0].attrs.type === 'external', 'media type is external');
  this.assert(blocks[0].content[0].attrs.url === 'https://github.com/user-attachments/assets/example.png', 'URL extracted correctly');
`).call({ assert, randomUUID });

// ─── Non-self-closing <img> tag ─────────────────────────────────────────────

console.log('\n=== Non-self-closing <img> tag ===');

buildRunner(`
  const md = '<img src="https://example.com/pic.png" alt="test">';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'mediaSingle', 'block is mediaSingle');
  this.assert(blocks[0].content[0].attrs.url === 'https://example.com/pic.png', 'URL correct');
`).call({ assert, randomUUID });

// ─── Markdown image: GitHub → Jira ──────────────────────────────────────────

console.log('\n=== Markdown image ![alt](url): GitHub → Jira ===');

buildRunner(`
  const md = '![screenshot](https://example.com/image.png)';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'mediaSingle', 'block is mediaSingle');
  this.assert(blocks[0].content[0].attrs.url === 'https://example.com/image.png', 'URL correct');
`).call({ assert, randomUUID });

// ─── Image: Jira → GitHub (round-trip) ──────────────────────────────────────

console.log('\n=== Image: Jira → GitHub (round-trip) ===');

buildRunner(`
  const md = '![screenshot](https://example.com/image.png)';
  const blocks = markdownToADFBlocks(md);
  const reversed = adfBlocksToMarkdown(blocks);

  this.assert(reversed.includes('![screenshot](https://example.com/image.png)'), 'round-trip keeps the alt text: ' + JSON.stringify(reversed));
`).call({ assert, randomUUID });

// ─── Mixed content: text + img on same line ─────────────────────────────────

console.log('\n=== Mixed content: text + img ===');

buildRunner(`
  const md = 'Check this: <img src="https://example.com/pic.png" />';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 2, 'produces 2 blocks (paragraph + mediaSingle)');
  this.assert(blocks[0].type === 'paragraph', 'first block is paragraph with remaining text');
  this.assert(blocks[1].type === 'mediaSingle', 'second block is mediaSingle');
`).call({ assert, randomUUID });

// ─── Indented checkboxes don't become paragraph text ────────────────────────

console.log('\n=== Indented checkboxes not swallowed by paragraph ===');

buildRunner(`
  const md = 'Some text\\n  - [ ] indented checkbox';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 2, 'produces 2 blocks (paragraph + taskList)');
  this.assert(blocks[0].type === 'paragraph', 'first is paragraph');
  this.assert(blocks[1].type === 'taskList', 'second is taskList');
`).call({ assert, randomUUID });

// ─── HTML <details>/<summary> → ADF expand ──────────────────────────────────

console.log('\n=== HTML <details>/<summary> → ADF expand ===');

buildRunner(`
  const md = '<details>\\n<summary>Related PRs</summary>\\n\\nSome content here\\n[link](https://example.com)\\n</details>';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces exactly 1 block');
  this.assert(blocks[0].type === 'expand', 'block is expand');
  this.assert(blocks[0].attrs.title === 'Related PRs', 'title matches summary text');
  this.assert(blocks[0].content.length > 0, 'has content blocks');
`).call({ assert, randomUUID });

// ─── Multiple <details> blocks ──────────────────────────────────────────────

console.log('\n=== Multiple <details> blocks ===');

buildRunner(`
  const md = '<details>\\n<summary>Section 1</summary>\\n\\nFirst\\n</details>\\n\\n<details>\\n<summary>Section 2</summary>\\n\\nSecond\\n</details>';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 2, 'produces 2 expand blocks');
  this.assert(blocks[0].type === 'expand', 'first is expand');
  this.assert(blocks[0].attrs.title === 'Section 1', 'first title correct');
  this.assert(blocks[1].type === 'expand', 'second is expand');
  this.assert(blocks[1].attrs.title === 'Section 2', 'second title correct');
`).call({ assert, randomUUID });

// ─── ADF expand → <details> round-trip ──────────────────────────────────────

console.log('\n=== ADF expand → <details> round-trip ===');

buildRunner(`
  const md = '<details>\\n<summary>Click to expand</summary>\\n\\nHidden content\\n</details>';
  const blocks = markdownToADFBlocks(md);
  const reversed = adfBlocksToMarkdown(blocks);

  this.assert(reversed.includes('<details>'), 'round-trip has <details>');
  this.assert(reversed.includes('<summary>Click to expand</summary>'), 'round-trip has summary');
  this.assert(reversed.includes('Hidden content'), 'round-trip has body content');
  this.assert(reversed.includes('</details>'), 'round-trip has </details>');
`).call({ assert, randomUUID });

// ─── HTML comments stripped ─────────────────────────────────────────────────

console.log('\n=== HTML comments stripped ===');

buildRunner(`
  const md = '<!-- This is a comment -->\\nVisible text\\n<!-- Another comment -->';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces 1 block (comment stripped)');
  this.assert(blocks[0].type === 'paragraph', 'block is paragraph');
  const text = blocks[0].content.map(n => n.text).join('');
  this.assert(!text.includes('comment'), 'comment text not in output: ' + JSON.stringify(text));
  this.assert(text.includes('Visible text'), 'visible text preserved');
`).call({ assert, randomUUID });

// ─── <details> with emoji in summary ────────────────────────────────────────

console.log('\n=== <details> with HTML tags in summary ===');

buildRunner(`
  const md = '<details>\\n<summary><sub>Check the box</sub></summary>\\n\\nContent\\n</details>';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks[0].type === 'expand', 'block is expand');
  this.assert(blocks[0].attrs.title === 'Check the box', 'HTML tags stripped from title');
`).call({ assert, randomUUID });

// ─── <details> without <summary> ─────────────────────────────────────────────

console.log('\n=== <details> without <summary> ===');

buildRunner(`
  const md = '<details>\\nSome hidden content\\n</details>';
  const blocks = markdownToADFBlocks(md);

  this.assert(blocks.length === 1, 'produces 1 block');
  this.assert(blocks[0].type === 'expand', 'block is expand');
  this.assert(blocks[0].attrs.title === 'Details', 'fallback title is Details');
`).call({ assert, randomUUID });

// ─── <blockquote> and <br> tags stripped ─────────────────────────────────────

console.log('\n=== <blockquote> and <br> tags stripped ===');

buildRunner(`
  const md = 'Line one<br>Line two\\n<blockquote>\\nQuoted text\\n</blockquote>';
  const blocks = markdownToADFBlocks(md);

  const allText = blocks.map(b => (b.content || []).map(n => n.text || '').join('')).join(' ');
  this.assert(!allText.includes('<blockquote>'), 'blockquote tag stripped');
  this.assert(!allText.includes('<br>'), 'br tag stripped');
  this.assert(allText.includes('Quoted text'), 'content preserved');
`).call({ assert, randomUUID });

// ─── Strikethrough: Markdown → ADF ───────────────────────────────────────────

console.log('\n=== Strikethrough: Markdown → ADF ===');

buildRunner(`
  const md = '~~deleted text~~';
  const blocks = markdownToADFBlocks(md);
  const para = blocks[0];

  this.assert(para.type === 'paragraph', 'block is paragraph');
  this.assert(para.content.length === 1, 'has 1 inline node');
  this.assert(para.content[0].text === 'deleted text', 'text content correct');
  this.assert(para.content[0].marks.length === 1, 'has 1 mark');
  this.assert(para.content[0].marks[0].type === 'strike', 'mark type is strike');
`).call({ assert, randomUUID });

// ─── Strikethrough: ADF → Markdown ───────────────────────────────────────────

console.log('\n=== Strikethrough: ADF → Markdown ===');

buildRunner(`
  const adf = [{
    type: 'paragraph',
    content: [{ type: 'text', text: 'deleted text', marks: [{ type: 'strike' }] }]
  }];
  const md = adfBlocksToMarkdown(adf);

  this.assert(md === '~~deleted text~~', 'ADF strike converts to ~~text~~: ' + JSON.stringify(md));
`).call({ assert, randomUUID });

// ─── Strikethrough: inline within sentence ───────────────────────────────────

console.log('\n=== Strikethrough: inline within sentence ===');

buildRunner(`
  const md = 'This has ~~removed~~ text in it';
  const blocks = markdownToADFBlocks(md);
  const content = blocks[0].content;

  this.assert(content.length === 3, 'has 3 inline nodes');
  this.assert(content[0].text === 'This has ', 'prefix text correct');
  this.assert(content[1].text === 'removed', 'strike text correct');
  this.assert(content[1].marks[0].type === 'strike', 'strike mark present');
  this.assert(content[2].text === ' text in it', 'suffix text correct');
`).call({ assert, randomUUID });

// ─── Strikethrough: single tilde ~text~ ─────────────────────────────────────

console.log('\n=== Strikethrough: single tilde ~text~ ===');

buildRunner(`
  const md = '~deleted text~';
  const blocks = markdownToADFBlocks(md);
  const para = blocks[0];

  this.assert(para.content.length === 1, 'has 1 inline node');
  this.assert(para.content[0].text === 'deleted text', 'text content correct');
  this.assert(para.content[0].marks[0].type === 'strike', 'single tilde mark is strike');
`).call({ assert, randomUUID });

// ─── Strikethrough: single tilde inline ─────────────────────────────────────

console.log('\n=== Strikethrough: single tilde inline ===');

buildRunner(`
  const md = 'item 4. ~things~';
  const blocks = markdownToADFBlocks(md);
  const content = blocks[0].content;

  this.assert(content.length === 2, 'has 2 inline nodes');
  this.assert(content[0].text === 'item 4. ', 'prefix text correct');
  this.assert(content[1].text === 'things', 'strike text correct');
  this.assert(content[1].marks[0].type === 'strike', 'single tilde strike mark present');
`).call({ assert, randomUUID });

// ─── Strikethrough: double tilde preferred over single ──────────────────────

console.log('\n=== Strikethrough: double tilde matched before single ===');

buildRunner(`
  const md = '~~double~~ and ~single~';
  const blocks = markdownToADFBlocks(md);
  const content = blocks[0].content;

  this.assert(content.length === 3, 'has 3 inline nodes');
  this.assert(content[0].text === 'double', 'double tilde text correct');
  this.assert(content[0].marks[0].type === 'strike', 'double tilde is strike');
  this.assert(content[2].text === 'single', 'single tilde text correct');
  this.assert(content[2].marks[0].type === 'strike', 'single tilde is strike');
`).call({ assert, randomUUID });

// ─── Strikethrough: mixed with other formatting ─────────────────────────────

console.log('\n=== Strikethrough: mixed with other formatting ===');

buildRunner(`
  const md = '**bold** and ~~struck~~ and *italic*';
  const blocks = markdownToADFBlocks(md);
  const content = blocks[0].content;

  this.assert(content.length === 5, 'has 5 inline nodes');
  this.assert(content[0].marks[0].type === 'strong', 'first is bold');
  this.assert(content[2].marks[0].type === 'strike', 'third is strikethrough');
  this.assert(content[2].text === 'struck', 'strike text correct');
  this.assert(content[4].marks[0].type === 'em', 'fifth is italic');
`).call({ assert, randomUUID });

// ─── Image alt text is preserved (47 of 342 real issue bodies lost it) ───────

console.log('\n=== Image alt text survives the round trip ===');

buildRunner(`
  const roundTrip = (md) => adfBlocksToMarkdown(markdownToADFBlocks(md));

  // Markdown image: alt stored on the media node and exported again
  const mdBlocks = markdownToADFBlocks('![Screen Shot 2022-01-19 at 8.50.45 PM](https://example.com/a.png)');
  this.assert(mdBlocks[0].content[0].attrs.alt === 'Screen Shot 2022-01-19 at 8.50.45 PM', 'markdown image alt is kept on the media node');
  this.assert(roundTrip('![Screen Shot 2022-01-19 at 8.50.45 PM](https://example.com/a.png)') === '![Screen Shot 2022-01-19 at 8.50.45 PM](https://example.com/a.png)', 'markdown image round-trips unchanged');

  // <img> tag: alt kept; width/height are intentionally not
  const imgBlocks = markdownToADFBlocks('<img width="1439" alt="Image" src="https://example.com/b.png" />');
  this.assert(imgBlocks[0].content[0].attrs.alt === 'Image', '<img> alt is kept on the media node');
  this.assert(roundTrip('<img width="1439" alt="Image" src="https://example.com/b.png" />') === '![Image](https://example.com/b.png)', '<img> exports as a markdown image with its alt');

  // No alt anywhere: no alt attribute is invented, export falls back to "image"
  const bare = markdownToADFBlocks('<img src="https://example.com/c.png">');
  this.assert(!('alt' in bare[0].content[0].attrs), 'no alt attribute when the source has none');
  this.assert(roundTrip('<img src="https://example.com/c.png">') === '![image](https://example.com/c.png)', 'missing alt falls back to "image"');

  // Alt text can't break the markdown syntax
  const odd = adfBlocksToMarkdown([{ type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'external', url: 'https://example.com/d.png', alt: 'a] b\\nc' } }] }]);
  this.assert(odd === '![a\\\\] b c](https://example.com/d.png)', 'closing bracket is escaped and line breaks removed: ' + JSON.stringify(odd));
`).call({ assert, randomUUID });

// ─── Emphasis: snake_case and spaced asterisks are not italics ───────────────

console.log('\n=== Emphasis does not fire inside words or around spaced asterisks ===');

buildRunner(`
  const text = (md) => parseMarkdownInline(md).map((n) => n.text).join('');
  const marked = (md) => parseMarkdownInline(md).filter((n) => n.marks && n.marks.length).length;

  // snake_case outside code used to become italics ("foo*bar and baz*qux")
  this.assert(marked('use foo_bar and baz_qux here') === 0, 'snake_case words are not italicised');
  this.assert(text('use foo_bar and baz_qux here') === 'use foo_bar and baz_qux here', 'snake_case text is unchanged');

  // an underscore before a code span must not swallow the code span
  const nodes = parseMarkdownInline('see foo_bar and then \`code_x\` too');
  this.assert(nodes.some((n) => n.text === 'code_x' && n.marks && n.marks[0].type === 'code'), 'code span keeps its underscore and code mark');
  this.assert(text('see foo_bar and then \`code_x\` too').includes('foo_bar'), 'text before the code span keeps its underscore');

  // spaced asterisks are arithmetic / literal, not emphasis
  this.assert(marked('2 * 3 * 4') === 0, 'spaced asterisks are not italics');

  // real emphasis still works
  const real = parseMarkdownInline('an _italic_ word, an *italic* word and **bold**');
  this.assert(real.filter((n) => n.marks && n.marks[0].type === 'em').length === 2, '_italic_ and *italic* at word boundaries still become italics');
  this.assert(real.filter((n) => n.marks && n.marks[0].type === 'strong').length === 1, '**bold** still becomes bold');
  this.assert(marked('(_italic_)') === 1 && marked('_italic_.') === 1, 'underscore emphasis works next to punctuation');
`).call({ assert, randomUUID });

// ─── Fenced code blocks honour the fence length ──────────────────────────────

console.log('\n=== Longer code fences can contain shorter ones ===');

buildRunner(`
  const md = '\`\`\`\`\`\`\\n\`\`\`hbs isBeta\\n\`\`\`\\n\`\`\`\`\`\`';
  const blocks = markdownToADFBlocks(md);
  this.assert(blocks.length === 1 && blocks[0].type === 'codeBlock', 'a six-backtick fence is one code block, not shredded paragraphs');
  this.assert(blocks[0].content[0].text === '\`\`\`hbs isBeta\\n\`\`\`', 'the inner three-backtick lines stay inside the block');

  // export picks a fence longer than anything inside, and re-parsing gives the same code back
  const exported = adfBlocksToMarkdown(blocks);
  this.assert(exported.startsWith('\`\`\`\`\\n') && exported.endsWith('\\n\`\`\`\`'), 'export fence is longer than the nested fence: ' + JSON.stringify(exported));
  const again = markdownToADFBlocks(exported);
  this.assert(again.length === 1 && again[0].content[0].text === blocks[0].content[0].text, 'exported block re-parses to the same code');

  // ordinary three-backtick blocks are unchanged
  const plain = markdownToADFBlocks('\`\`\`js\\nconst a = 1;\\n\`\`\`');
  this.assert(plain.length === 1 && plain[0].attrs.language === 'js' && plain[0].content[0].text === 'const a = 1;', 'plain fenced block unchanged');
  this.assert(adfBlocksToMarkdown(plain) === '\`\`\`js\\nconst a = 1;\\n\`\`\`', 'plain fenced block exports with a three-backtick fence');
`).call({ assert, randomUUID });

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
