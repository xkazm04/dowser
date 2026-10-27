// Doc-impact byline (confluence:contentBylineItem): the open and accepted Dowser proposals that name this page,
// either as evidence or in their doc impact (`byline.forPage`). Each links to its card in the Dowser inbox in
// Jira (`inbox?ref=DW-n`); an accepted one also links to its Jira issue.
import React from 'react';
import { router } from '@forge/bridge';
import { call } from '../../api.js';
import { ErrorState, Lozenge, SectionMessage, SkeletonList, useAsync } from '../../components/ui.jsx';
import { LensBadge } from '../../components/ProposalCard.jsx';
import { STATUS_APPEARANCE, STATUS_LABELS, plural } from '../../components/labels.js';
import '../../components/viz.css';

/**
 * The Dowser inbox in Jira, as an absolute URL: `<site>/jira/apps/<appId>/<environmentId>/inbox`. The app id
 * comes from the extension's localId (`ari:cloud:ecosystem::extension/<appId>/<envId>/static/<moduleKey>`).
 * Undefined when the context does not carry what it needs; the ref is then plain text.
 * @param {any} context
 */
function inboxHref(context) {
  const site = String(context?.siteUrl ?? '').replace(/\/+$/, '').replace(/\/wiki$/, '');
  const m = /extension\/([^/]+)\/([^/]+)\//.exec(String(context?.localId ?? ''));
  const env = context?.environmentId ?? m?.[2];
  if (!/^https:\/\//.test(site) || !m || !env) return undefined;
  return `${site}/jira/apps/${encodeURIComponent(m[1])}/${encodeURIComponent(env)}/inbox`;
}

/**
 * Why this card names the page: the quote of its page evidence, else that it is cited, else doc impact.
 * @param {any} card @param {string} pageId
 */
function whyNamed(card, pageId) {
  const ev = (card.evidence ?? []).filter((e) => e.type === 'page' && e.ref === pageId);
  const quoted = ev.find((e) => e.quote);
  if (quoted) return { kind: 'quote', text: quoted.quote };
  if (ev.length > 0) return { kind: 'text', text: 'Cited as evidence.' };
  if ((card.doc_impact ?? []).includes(pageId)) return { kind: 'text', text: 'Listed in doc impact: this page needs an update when the proposal ships.' };
  return { kind: 'text', text: 'Names this page.' };
}

function openExternal(e, href) {
  e.preventDefault();
  router.open(href).catch(() => window.open(href, '_blank', 'noopener'));
}

export default function Byline({ context }) {
  const pageId = context?.extension?.content?.id ? String(context.extension.content.id) : '';
  const data = useAsync(
    () => (pageId ? call('byline.forPage', { page_id: pageId }) : Promise.resolve({ count: 0, cards: [] })),
    [pageId],
  );
  const href = inboxHref(context);

  return (
    <main className="dw-root dw-root--byline">
      {data.status === 'loading' && <SkeletonList count={1} label="Loading Dowser proposals" />}
      {data.status === 'error' && <ErrorState what="Dowser proposals" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && (data.data.cards ?? []).length === 0 && (
        <SectionMessage role="status"><p>No Dowser proposals mention this page.</p></SectionMessage>
      )}
      {data.status === 'ready' && (data.data.cards ?? []).length > 0 && (
        <>
          <h2 className="dw-h2">{plural(data.data.count ?? data.data.cards.length, 'Dowser proposal')}</h2>
          <p className="dw-subtlest" style={{ margin: '2px 0 0' }}>Open or accepted proposals that name this page.</p>
          <ul className="dw-byline-list">
            {data.data.cards.map((card) => {
              const why = whyNamed(card, pageId);
              return (
                <li key={card.ref}>
                  <div className="dw-row" style={{ gap: 6 }}>
                    {href
                      ? <a href={`${href}?ref=${encodeURIComponent(card.ref)}`} target="_blank" rel="noreferrer noopener" onClick={(e) => openExternal(e, `${href}?ref=${encodeURIComponent(card.ref)}`)} title="Open in the Dowser inbox in Jira">{card.ref}</a>
                      : <span className="dw-subtlest">{card.ref}</span>}
                    <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge>
                    <LensBadge lens={card.lens} />
                    {card.issue_ref && (card.issue_url
                      ? <a href={card.issue_url} target="_blank" rel="noreferrer noopener" onClick={(e) => openExternal(e, card.issue_url)}>{card.issue_ref}</a>
                      : <span>{card.issue_ref}</span>)}
                  </div>
                  <span className="dw-byline__title">{card.title}</span>
                  {why.kind === 'quote'
                    ? <blockquote className="dw-quote" style={{ marginLeft: 0 }}>{why.text}</blockquote>
                    : <p className="dw-byline__why">{why.text}</p>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
