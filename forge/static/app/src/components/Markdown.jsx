// Renders parseMarkdown() blocks as React elements. Text only ever goes through React's escaping: there is no
// dangerouslySetInnerHTML anywhere, so a card body cannot inject markup.
import React from 'react';
import { parseMarkdown } from './markdown.js';

function Spans({ spans }) {
  return spans.map((s, i) => (s.code ? <code key={i}>{s.text}</code> : <React.Fragment key={i}>{s.text}</React.Fragment>));
}

/** @param {{source: string, children?: React.ReactNode}} props  `children` render after the parsed blocks. */
export function Markdown({ source, children }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="dw-md">
      {blocks.map((b, i) => {
        if (b.type === 'heading') return <h4 key={i}>{b.text}</h4>;
        if (b.type === 'paragraph') return <p key={i}><Spans spans={b.spans} /></p>;
        const List = b.ordered ? 'ol' : 'ul';
        return <List key={i}>{b.items.map((it, j) => <li key={j}><Spans spans={it} /></li>)}</List>;
      })}
      {children}
    </div>
  );
}
