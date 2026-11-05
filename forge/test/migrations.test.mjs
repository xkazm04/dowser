// @ts-check
// src/sql/migrations.mjs is append-only: @forge/sql's runner skips any name already in `__migrations`, so an edited
// shipped statement never reaches an installed database, while the tests (which rebuild the schema from
// MIGRATIONS) would pass on it. Each shipped migration is pinned here by the sha256 of its statement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MIGRATIONS } from '../src/sql/migrations.mjs';

/** Shipped migrations: name -> first 16 hex of sha256(statement). A new migration adds its line here. */
const SHIPPED = new Map([
  ['v001_counters', 'c9c5fe82e2aaf51d'],
  ['v002_inboxes', 'cfa1017debd4304f'],
  ['v003_proposals', 'adee8d336b5bb7d5'],
  ['v004_proposals_status_ix', 'f3be273918fb6d4f'],
  ['v005_proposals_issue_ix', '048af3cc29932218'],
  ['v006_evidence', '0c9082fb2d22e3a5'],
  ['v007_evidence_type_ix', 'ef926021ef3538b1'],
  ['v008_verdicts', 'e36bda18d1dd815a'],
  ['v009_pushes', '82dd65bd849fbe4a'],
  ['v010_pushes_run_ix', 'dd3508a487a0ec5b'],
  ['v011_areas', '8e260bbea0623f66'],
  ['v012_rules', 'bd2b00708c5d3672'],
  ['v013_outcomes', '59516b75a1a94ceb'],
  ['v014_outcomes_project_ix', '878287a5c4218b6a'],
  ['v015_directions', '38537d0efad0d42c'],
  ['v016_proposals_snooze_until', '21dcc4dc673f0dbb'],
  ['v017_verdicts_snooze_until', 'a7b9ea3fdd27c5f7'],
  ['v018_inboxes_created_by', '52dbe63ab2c07e55'],
  ['v019_proposals_score', '72eaab4680a300f3'],
  ['v020_proposals_band', 'd24ba31b4d192982'],
  ['v021_proposals_mvp', '3a59e19acad02d03'],
  ['v022_proposals_pretriaged_by', '1bf7a35702b1019f'],
  ['v023_trust', '9aef031e0f40889e'],
  ['v024_tool_calls', '68ff9b59f06534e9'],
  ['v025_pushes_scanned_at', 'f1593170ba2c553b'],
  ['v026_proposals_issue_prop_at', 'f9dc818fc6771c5e'],
  ['v027_deliveries', '00cd4804ae5e5057'],
  ['v028_work_reports', 'c90e85d23b065b9c'],
  ['v029_work_reports_proposal_ix', '8dff797794a55ad7'],
  ['v030_page_links', 'c7d548d360adedc4'],
  ['v031_page_edits', '4d74be7e01af1cc1'],
]);

/** @param {string} s */
const digest = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
/** @param {string} name */
const seq = (name) => Number(/^v(\d{3})_[a-z0-9_]+$/.exec(name)?.[1] ?? NaN);

test('no shipped migration was edited or removed', () => {
  const byName = new Map(MIGRATIONS.map((m) => [m.name, m.statement]));
  for (const [name, want] of SHIPPED) {
    const statement = byName.get(name);
    assert.ok(statement !== undefined, `${name} has shipped and cannot be removed`);
    assert.equal(digest(statement), want, `${name} has shipped and was edited; append a new migration instead`);
  }
});

test('migration names are vNNN_snake, consecutive and unique, and new ones come after the shipped ones', () => {
  let last = 0;
  let seenNew = false;
  for (const m of MIGRATIONS) {
    const n = seq(m.name);
    assert.ok(Number.isInteger(n), `${m.name} is not vNNN_name`);
    assert.equal(n, last + 1, `${m.name} must be v${String(last + 1).padStart(3, '0')}_...: numbers are consecutive and never reused`);
    last = n;
    if (!SHIPPED.has(m.name)) seenNew = true;
    else assert.ok(!seenNew, `${m.name} is shipped but follows a new migration; append only at the end`);
  }
});
