// Variant 2 evidence panel (jira:issuePanel, ~360px): reads like Jira's own issue fields. Label / value pairs,
// the lens dot, evidence as a compact list. Read-only.
import React from 'react';
import { call } from '../../../api.js';
import { ErrorState, Lozenge, useAsync } from '../../../components/ui.jsx';
import { EvidenceList, TriageHistory } from '../../../components/ProposalCard.jsx';
import { Mark } from '../../../components/Brand.jsx';
import {
  LENS_LABELS, LEVEL_LABELS, STATUS_APPEARANCE, STATUS_LABELS, evidenceStrength, plural,
} from '../../../components/labels.js';
import { LensDot } from '../shared.jsx';
import { effortDays } from '../inbox/Entry.jsx';

export default function Panel({ context }) {
  const issueKey = context?.extension?.issue?.key;
  const data = useAsync(
    () => (issueKey ? call('panel.forIssue', { issue_key: issueKey }) : Promise.resolve({ history: [] })),
    [issueKey],
  );
  const card = data.status === 'ready' ? data.data.card : undefined;
  return (
    <main className="dw2-panel">
      <p className="dw2-panel__brand"><Mark size={16} />Dowser evidence</p>
      {data.status === 'loading' && (
        <div role="status" aria-label="Loading Dowser evidence" aria-busy="true">
          <div className="dw-skel dw2-sk dw2-sk--line" /><div className="dw-skel dw2-sk dw2-sk--line" /><div className="dw-skel dw2-sk dw2-sk--line dw2-sk--short" />
        </div>
      )}
      {data.status === 'error' && <ErrorState what="Dowser evidence" error={data.error} onRetry={data.reload} />}
      {data.status === 'ready' && !card && <p className="dw2-muted" role="status">This issue did not come from Dowser.</p>}
      {card && <PanelBody card={card} history={data.data.history ?? []} />}
    </main>
  );
}

function PanelBody({ card, history }) {
  const strength = evidenceStrength(card);
  const basis = card.effort?.basis ?? [];
  const r = card.delivery_risk;
  const code = (s) => <span className="dw-evidence__ref">{s}</span>;
  return (
    <>
      <p className="dw2-rationale dw2-rationale--panel">{card.rationale}</p>
      <dl className="dw2-fields">
        <dt>Proposal</dt>
        <dd><span className="dw2-mono">{card.ref}</span> <Lozenge appearance={STATUS_APPEARANCE[card.status] ?? 'default'}>{STATUS_LABELS[card.status] ?? card.status}</Lozenge></dd>
        <dt>Lens</dt>
        <dd><span className="dw2-meta__lens"><LensDot lens={card.lens} />{LENS_LABELS[card.lens] ?? card.lens}</span></dd>
        <dt>Confidence</dt>
        <dd>{LEVEL_LABELS[card.confidence] ?? card.confidence}{card.confidence_why && <span className="dw2-note">{card.confidence_why}</span>}</dd>
        <dt>Effort</dt>
        <dd>
          {card.effort ? <>{card.effort.size}{effortDays(card.effort) && <> &middot; {effortDays(card.effort)}</>}</> : <span className="dw2-muted">Not estimated</span>}
          {basis.length > 0 && <span className="dw2-note">Rests on {basis.map((b, i) => <span key={b}>{i > 0 && ', '}{code(b)}</span>)}</span>}
        </dd>
        <dt>Evidence</dt>
        <dd>
          <span className="dw2-meter" aria-hidden="true">{[1, 2, 3, 4].map((n) => <i key={n} className={n <= strength.level ? 'on' : ''} />)}</span>{' '}
          {strength.label}<span className="dw2-muted"> &middot; {plural(strength.count, 'item')}</span>
        </dd>
        <dt>Delivery risk</dt>
        <dd>
          {r
            ? <>Blast radius {(LEVEL_LABELS[r.blast] ?? r.blast).toLowerCase()}, {r.bus_factor !== undefined ? <>bus factor {r.bus_factor}{r.bus_factor <= 1 && <span className="dw2-spec__warn"> &middot; Single owner</span>}</> : <span className="dw2-muted">bus factor not measured</span>}</>
            : <span className="dw2-muted">Not measured</span>}
        </dd>
        <dt>Doc impact</dt>
        <dd>{card.doc_impact && card.doc_impact.length > 0 ? card.doc_impact.map((d, i) => <span key={d}>{i > 0 && ', '}{code(d)}</span>) : <span className="dw2-muted">None named</span>}</dd>
      </dl>
      <h2 className="dw2-eyebrow dw2-panel__h">Evidence ({card.evidence?.length ?? 0})</h2>
      <EvidenceList evidence={card.evidence ?? []} />
      <h2 className="dw2-eyebrow dw2-panel__h">Triage history</h2>
      <TriageHistory history={history} />
    </>
  );
}
