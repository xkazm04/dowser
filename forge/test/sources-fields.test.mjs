// @ts-check
// Ticket source items carry the fields a demand table needs (lens-quality-plan WP4): components, labels and
// created_at when Jira has them, omitted keys when it has none. ticketItem is the adapter's mapping, tested on
// fake /rest/api/3/search/jql issues; the tool test drives a fake Sources port through the MCP surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps } from './helpers.mjs';
import { runTool } from '../src/core/app.mjs';
import { TICKET_FIELDS, ticketItem } from '../src/core/sources.mjs';

const SITE = 'https://acme.atlassian.net';

test('ticketItem: components, labels and created_at are mapped when Jira has them', () => {
  const it = ticketItem({
    key: 'SUP-7',
    fields: {
      summary: 'Export is slow', description: 'Takes minutes.', created: '2026-09-02T10:15:00.000+0200',
      labels: ['export', 'perf'], components: [{ id: '1', name: 'Reports' }, { id: '2', name: 'Billing' }],
    },
  }, SITE);
  assert.deepEqual(it, {
    ref: 'SUP-7', title: 'Export is slow', url: `${SITE}/browse/SUP-7`, body: 'Takes minutes.',
    created_at: '2026-09-02T08:15:00.000Z', labels: ['export', 'perf'], components: ['Reports', 'Billing'],
  });
});

test('ticketItem: empty or missing lists and dates are omitted, never [] or null', () => {
  for (const fields of [
    { summary: 's', labels: [], components: [] },
    { summary: 's', labels: null, components: null, created: null },
    { summary: 's', components: [{ id: '3' }], labels: [''], created: 'not a date' },
    { summary: 's' },
  ]) {
    const it = ticketItem({ key: 'SUP-8', fields }, SITE);
    assert.deepEqual(Object.keys(it).sort(), ['body', 'ref', 'title', 'url'], JSON.stringify(fields));
  }
});

test('the tickets search requests every field ticketItem reads', () => {
  for (const f of ['summary', 'description', 'labels', 'components', 'created']) assert.ok(TICKET_FIELDS.includes(f), f);
});

test('dowser_sources_tickets passes components/labels/created_at through and keeps their absence', async () => {
  const d = makeDeps();
  d.sources = {
    pages: async () => [],
    goals: async () => [],
    tickets: async () => [
      ticketItem({ key: 'SUP-1', fields: { summary: 'a', created: '2026-10-01T00:00:00Z', labels: ['x'], components: [{ name: 'Checkout' }] } }, SITE),
      ticketItem({ key: 'SUP-2', fields: { summary: 'b' } }, SITE),
    ],
  };
  const out = /** @type {any} */ (await runTool(d, 'dowser_sources_tickets', { query: 'export', limit: 5 }, ME));
  assert.deepEqual(out.items[0], { ref: 'SUP-1', title: 'a', url: `${SITE}/browse/SUP-1`, body: '', created_at: '2026-10-01T00:00:00.000Z', labels: ['x'], components: ['Checkout'] });
  assert.deepEqual(out.items[1], { ref: 'SUP-2', title: 'b', url: `${SITE}/browse/SUP-2`, body: '' });
});
