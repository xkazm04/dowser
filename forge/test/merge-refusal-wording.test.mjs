// @ts-check
// DW-194: "Say a Jira key may not exist when a merge into it is refused". A 404 from the permission lookup reads as no
// permission. Done means "the message also says the issue may not exist or may be hidden from them. It stays one answer
// for both, so a hidden issue is not revealed." After: "1 message naming both".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ME, makeDeps, pushArgs, record } from './helpers.mjs';
import { runResolver, runRovo, runTool } from '../src/core/app.mjs';

const NOT_THERE = /(may|might|does) not exist|doesn't exist|no such issue|mistyped/i;

async function denied() {
  const d = makeDeps();
  await runTool(d, 'dowser_proposals_push', pushArgs([record()]), ME);
  d.perms.deny.add('ADD_COMMENTS:SHOP-1234');
  return d;
}

test('DW-194: a merge into a key the check says no to names both causes, from the inbox', async () => {
  const d = await denied();
  const out = /** @type {any} */ (await runResolver(d, 'verdict.merge', { ref: 'DW-1', into: 'SHOP-1234' }, ME, 'inbox'));
  assert.equal(out.error, 'forbidden');
  assert.match(out.message, /SHOP-1234/);
  assert.match(out.message, /permission/i, 'one cause: no permission');
  assert.match(out.message, NOT_THERE, 'the other cause: the issue is not there');
  assert.equal(d.jira.comments.length, 0);
});

test('DW-194: the same refusal through the Rovo agent', async () => {
  const d = await denied();
  const out = /** @type {any} */ (await runRovo(d, 'dowser_verdict_record', { ref: 'DW-1', status: 'merged', merged_into: 'SHOP-1234' }, ME));
  assert.equal(out.error, 'forbidden');
  assert.match(out.message, /permission/i);
  assert.match(out.message, NOT_THERE);
});
