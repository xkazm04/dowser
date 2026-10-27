// @ts-check
// Atlassian document format (ADF) in both directions, pure: the issue description an accept creates and the
// comment a merge into a Jira issue adds (F5), and ADF / Confluence storage HTML to plain text for the
// source tools. ADF reference: developer.atlassian.com/cloud/jira/platform/apis/document/structure/.

/**
 * @typedef {import('./ports.mjs').AdfNode} AdfNode
 * @typedef {import('./ports.mjs').AdfDoc} AdfDoc
 * @typedef {import('./types.mjs').Card} Card
 */

/** @param {string} t @param {AdfNode[]} [marks] @returns {AdfNode} */
const text = (t, marks) => (marks && marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
/** @param {AdfNode[]} content @returns {AdfNode} */
const paragraph = (content) => ({ type: 'paragraph', content });
/** @param {number} level @param {string} t @returns {AdfNode} */
const heading = (level, t) => ({ type: 'heading', attrs: { level }, content: [text(t)] });
/** @param {AdfNode[][]} items @param {boolean} [ordered] @returns {AdfNode} */
const list = (items, ordered = false) => ({
  type: ordered ? 'orderedList' : 'bulletList',
  content: items.map((c) => ({ type: 'listItem', content: [paragraph(c)] })),
});
/** @param {string} href @returns {AdfNode} */
const linkMark = (href) => ({ type: 'link', attrs: { href } });

/**
 * Inline Markdown-ish text to ADF text nodes: `code` spans become code marks, the rest stays plain.
 * @param {string} s
 * @returns {AdfNode[]}
 */
function inline(s) {
  /** @type {AdfNode[]} */
  const out = [];
  for (const [i, part] of s.split('`').entries()) {
    if (!part) continue;
    out.push(i % 2 === 1 ? text(part, [{ type: 'code' }]) : text(part));
  }
  return out.length ? out : [text(' ')];
}

/**
 * A Markdown card body (`## ` sections, paragraphs, `-`/`*`/`1.` lists) as ADF blocks. Headings become level 3
 * so they sit under the issue's own structure; anything richer stays as plain text.
 * @param {string} md
 * @returns {AdfNode[]}
 */
export function markdownToAdf(md) {
  /** @type {AdfNode[]} */
  const blocks = [];
  /** @type {string[]} */
  let para = [];
  /** @type {{ordered: boolean, items: string[]} | undefined} */
  let lst;
  const flush = () => {
    if (para.length) blocks.push(paragraph(inline(para.join(' '))));
    para = [];
    if (lst) blocks.push(list(lst.items.map(inline), lst.ordered));
    lst = undefined;
  };
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const h = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    const b = line.match(/^[-*+]\s+(.+)$/);
    const o = line.match(/^\d+[.)]\s+(.+)$/);
    if (!line) { flush(); continue; }
    if (h) { flush(); blocks.push(heading(3, h[1])); continue; }
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

/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The evidence list (F2 link rules already applied on the card: `link` when there is one).
 * @param {Card} card
 * @returns {AdfNode}
 */
function evidenceList(card) {
  return list(card.evidence.map((e) => {
    /** @type {AdfNode[]} */
    const c = [text(`${e.type}: `), text(e.ref, e.link ? [linkMark(e.link)] : [{ type: 'code' }])];
    if (e.quote) c.push(text(` - "${clip(e.quote.replace(/\s+/g, ' ').trim(), 200)}"`));
    return c;
  }));
}

/**
 * The description of the issue an accept creates (contract amendment 3, the UI preview shows the same order):
 * rationale, the card body (its five sections), the evidence list with links, then "Proposed by Dowser (DW-n)".
 * @param {Card} card
 * @param {string} [inboxUrl]
 * @returns {AdfDoc}
 */
export function issueDescription(card, inboxUrl) {
  /** @type {AdfNode[]} */
  const content = [paragraph(inline(String(card.rationale)))];
  content.push(...markdownToAdf(String(card.body ?? '')));
  content.push(heading(3, 'Evidence'), evidenceList(card));
  content.push(paragraph([text('Proposed by Dowser ('), text(card.ref, inboxUrl ? [linkMark(inboxUrl)] : undefined), text(')')]));
  return { type: 'doc', version: 1, content };
}

/**
 * The comment a merge into an existing Jira issue adds: what was merged and its evidence.
 * @param {Card} card
 * @param {string} [inboxUrl]
 * @returns {AdfDoc}
 */
export function mergeComment(card, inboxUrl) {
  return {
    type: 'doc', version: 1, content: [
      paragraph([text('Dowser merged '), text(card.ref, inboxUrl ? [linkMark(inboxUrl)] : undefined), text(` "${card.title}" into this issue. Its evidence:`)]),
      evidenceList(card),
    ],
  };
}

const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow', 'rule', 'panel']);

/**
 * ADF (a Jira description) as plain text: text nodes joined, one line per block.
 * @param {unknown} node
 * @returns {string}
 */
export function adfToText(node) {
  if (typeof node === 'string') return node;
  /** @type {string[]} */
  const out = [];
  /** @param {any} n */
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') out.push(n.text);
    else if (n.type === 'hardBreak') out.push('\n');
    else if ((n.type === 'mention' || n.type === 'emoji') && n.attrs?.text) out.push(String(n.attrs.text));
    else if (n.type === 'inlineCard' && n.attrs?.url) out.push(String(n.attrs.url));
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    if (BLOCK_TYPES.has(n.type)) out.push('\n');
  };
  walk(node);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** @type {Record<string, string>} */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * Confluence storage-format / view HTML as plain text.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Trims text to about `max` characters at a word boundary.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function trimText(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.8 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}
