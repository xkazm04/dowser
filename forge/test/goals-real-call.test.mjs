// @ts-check
// p-a0950f: the goals call through the REAL @forge/api, not the useForgeApi seam. Only the runtime's two globals are
// supplied (what Forge injects), so asUser().requestTeamworkGraph builds the request itself: this is what the app sends
// once it is allowlisted. What it cannot show is Atlassian's answer; for that, call dowser_sources_goals on a deployed
// environment. AtlassianGoal's fields below are the object type's reference page
// (developer.atlassian.com/platform/teamwork-graph/api-reference/object-types/AtlassianGoal/, read 2026-11-06).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sources } from '../src/adapters/atlassian.mjs';
import { goalItems } from '../src/core/sources.mjs';

const GOAL_FIELDS = new Set(['archived', 'createdAt', 'description', 'dueDateEndedAt', 'dueDateStartedAt', 'goalType', 'id', 'key',
  'name', 'owner', 'parentGoalId', 'startedAt', 'updatedAt', 'url', 'watcherCount', 'watching']);
const CONTEXT = 'ari:cloud:jira::site/1';

const g = /** @type {any} */ (globalThis);
/** @type {{target: any, path: string, init: any}[]} */
let sent = [];
/** @type {any} */
let answer;

beforeEach(() => {
  sent = [];
  g.__forge_runtime__ = { contextAri: CONTEXT };
  g.__forge_fetch__ = async (/** @type {any} */ target, /** @type {string} */ path, /** @type {any} */ init) => {
    sent.push({ target, path, init });
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => { delete g.__forge_runtime__; delete g.__forge_fetch__; });

const documented = {
  data: { cypherQuery: { edges: [{ node: { columns: [{ key: 'goals', value: { __typename: 'CypherQueryResultListNode', nodes: [
    { id: 'ari:cloud:townsquare::goal/1', data: { __typename: 'AtlassianGoal', id: 'ari:cloud:townsquare::goal/1', name: 'Grow revenue', url: 'https://home.atlassian.com/goal/1', description: 'Grow it', archived: false } },
    { id: 'ari:cloud:townsquare::goal/2', data: { __typename: 'AtlassianGoal', id: 'ari:cloud:townsquare::goal/2', name: 'Old goal', url: 'https://home.atlassian.com/goal/2', description: null, archived: true } },
    { id: 'ari:cloud:townsquare::goal/3', data: { __typename: 'AtlassianGoal', id: 'ari:cloud:townsquare::goal/3', name: 'No link', url: null } },
  ] } }] } }] } },
};

test('the real requestTeamworkGraph: as the user, to the TWG endpoint, with the site context and the Cypher variable', async () => {
  answer = documented;
  await sources.goals();
  assert.equal(sent.length, 1);
  const [{ target, path, init }] = sent;
  assert.equal(target.provider, 'user');
  assert.equal(target.remote, 'stargate');
  assert.equal(path, '/graphql/twg');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Query-Context'], CONTEXT);
  const body = JSON.parse(init.body);
  assert.match(body.query, /query dowser_goals\(\$cypherQuery: String!\)/);
  assert.match(body.variables.cypherQuery, /^MATCH \(goal:AtlassianGoal\) RETURN collect\(distinct goal\) as goals$/);
});

test('the query asks AtlassianGoal only for fields the object type has (an unknown one is a ValidationError for the whole query)', async () => {
  answer = documented;
  await sources.goals();
  const { query } = JSON.parse(sent[0].init.body);
  const asked = /\.\.\. on AtlassianGoal \{([^}]*)\}/.exec(query)?.[1].trim().split(/\s+/) ?? [];
  assert.ok(asked.length > 0, 'the query has an AtlassianGoal selection');
  assert.deepEqual(asked.filter((f) => !GOAL_FIELDS.has(f)), []);
  for (const need of ['id', 'name', 'url', 'description']) assert.ok(asked.includes(need), `the mapping reads ${need}`);
});

test('the answer as the real call hands it over maps to source items: archived is the status, no link is left out', async () => {
  answer = documented;
  assert.deepEqual(await sources.goals(), [
    { ref: 'ari:cloud:townsquare::goal/1', title: 'Grow revenue', url: 'https://home.atlassian.com/goal/1', body: 'Grow it' },
    { ref: 'ari:cloud:townsquare::goal/2', title: 'Old goal', url: 'https://home.atlassian.com/goal/2', body: 'Old goal', status: 'archived' },
  ]);
});

test('goalItems is pure: the walk counts every goal seen, with or without a link', () => {
  const { items, seen } = goalItems(documented);
  assert.equal(seen, 3);
  assert.equal(items.length, 2);
  assert.deepEqual(goalItems({}), { items: [], seen: 0 });
});
