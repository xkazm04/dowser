// Two small pieces of the proposal card that other screens share: the lens badge (byline) and the triage history
// (routes/inbox/Detail.jsx, which renders the card itself in the inbox, the evidence panel and CardDialog).
import React from 'react';
import { Lozenge } from './ui.jsx';
import { safeHref } from '../safeHref.js';
import { LENS_LABELS, REASON_LABELS, STATUS_APPEARANCE, STATUS_LABELS, comesBack, deciderName, delegateChip, formatDate, isDelegate } from './labels.js';

/** @param {{lens: string}} props */
export function LensBadge({ lens }) {
  return <span className={`dw-lens dw-lens--${lens}`}>{LENS_LABELS[lens] ?? lens}</span>;
}

/** @param {{history: any[]}} props */
export function TriageHistory({ history }) {
  if (!history || history.length === 0) return <p className="dw-subtle" style={{ margin: '4px 0 0' }}>No triage decisions yet.</p>;
  return (
    <ol className="dw-history">
      {history.map((v, i) => (
        <li key={`${v.decided_at}:${i}`}>
          <Lozenge appearance={STATUS_APPEARANCE[v.status] ?? 'default'}>{STATUS_LABELS[v.status] ?? v.status}</Lozenge>{' '}
          {v.reason && <>{REASON_LABELS[v.reason] ?? v.reason} </>}
          {v.merged_into && <>into {v.merged_into} </>}
          {v.issue_ref && (safeHref(v.issue_url) ? <a href={safeHref(v.issue_url)} target="_blank" rel="noreferrer noopener">{v.issue_ref}</a> : v.issue_ref)}
          {isDelegate(v.decided_by)
            ? <span className="dw-subtlest"> · <span title="Recorded by a delegate a person switched on in Dowser Settings, not by a person"><Lozenge appearance="delegate">{delegateChip(v.decided_by)}</Lozenge></span> · {formatDate(v.decided_at)}</span>
            : <span className="dw-subtlest"> · {deciderName(v.decided_by, v.decided_by_name)} · {formatDate(v.decided_at)}</span>}
          {v.status === 'snoozed' && v.snooze_until && <div className="dw-subtle">{comesBack(v.snooze_until)}.</div>}
          {v.note && <div className="dw-note"><span className="dw-note__k">Note</span>{v.note}</div>}
        </li>
      ))}
    </ol>
  );
}
