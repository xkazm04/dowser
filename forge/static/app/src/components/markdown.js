// The Markdown subset of a card body, parsed into plain blocks. It mirrors `markdownToAdf` in
// forge/src/core/adf.mjs line for line (same regexes, same joining of paragraph lines with a space, same inline
// rule: only `code` spans), so the Accept preview shows what the Jira issue will contain. Pure: no DOM, no HTML.

/**
 * @typedef {{text: string, code: boolean}} Span
 * @typedef {{type: 'heading', text: string} | {type: 'paragraph', spans: Span[]} | {type: 'list', ordered: boolean, items: Span[][]}} Block
 */

/** @param {string} s @returns {Span[]} */
export function inlineSpans(s) {
  /** @type {Span[]} */
  const out = [];
  for (const [i, part] of s.split('`').entries()) {
    if (!part) continue;
    out.push({ text: part, code: i % 2 === 1 });
  }
  return out.length ? out : [{ text: ' ', code: false }];
}

/** @param {string} md @returns {Block[]} */
export function parseMarkdown(md) {
  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ordered: boolean, items: string[]} | undefined} */
  let lst;
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', spans: inlineSpans(para.join(' ')) });
    para = [];
    if (lst) blocks.push({ type: 'list', ordered: lst.ordered, items: lst.items.map(inlineSpans) });
    lst = undefined;
  };
  for (const raw of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    const b = line.match(/^[-*+]\s+(.+)$/);
    const o = line.match(/^\d+[.)]\s+(.+)$/);
    if (!line) { flush(); continue; }
    if (h) { flush(); blocks.push({ type: 'heading', text: h[1] }); continue; }
    if (b || o) {
      const ordered = !!o;
      if (para.length || (lst && lst.ordered !== ordered)) flush();
      lst ??= { ordered, items: [] };
      lst.items.push(/** @type {RegExpMatchArray} */ (b ?? o)[1]);
      continue;
    }
    if (lst) flush();
    para.push(line);
  }
  flush();
  return blocks;
}
