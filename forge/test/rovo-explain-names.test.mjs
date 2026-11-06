// @ts-check
// DW-195: "Name the person who decided when the Rovo agent explains a proposal". Done means "each history row carries
// decided_by_name when it is known. A row with no known name stays as it is." After: "2 of 2" history readers add names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runRovo, runTool } from '../src/core/app.mjs';

async function decided() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  await runRovo(d, 'dowser_verdict_record', { ref: 'DW-1', status: 'rejected', reason: 'not-our-direction' }, ME);
  return d;
}
/** @param {ReturnType<typeof makeDeps>} d */
const explain = async (d) => /** @type {any} */ (await runRovo(d, 'dowser_proposal_explain', { ref: 'DW-1' }, ME));

test('DW-195: dowser_proposal_explain names the decider, as proposal.get does', async () => {
  const d = await decided();
  const ex = await explain(d);
  assert.equal(ex.history.length, 1);
  assert.equal(ex.history[0].decided_by_name, 'Pat Person');
  const got = /** @type {any} */ (await runResolver(d, 'proposal.get', { ref: 'DW-1' }, ME, 'inbox'));
  assert.deepEqual(ex.history, got.history, 'the same history as the inbox reads');
});

test('DW-195: a row with no known name stays as it is', async () => {
  const d = await decided();
  d.users.directory = {};
  const row = (await explain(d)).history[0];
  assert.match(row.decided_by, /^forge:/);
  assert.equal('decided_by_name' in row, false);
});
