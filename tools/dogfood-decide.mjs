#!/usr/bin/env node
// @ts-check
// dogfood-decide - the team's side of a dogfood campaign (tools/dogfood.mjs --campaign): reads and decides the
// mock Forge inbox in the campaign's forge-state.json, through the mock's own test tools, so the next scan pulls
// the verdicts, rule decisions and outcomes exactly as it would from Forge.
//
//   node tools/dogfood-decide.mjs --campaign <dir> inbox [--status s]      inbox items: ref, fp, lens, status, title
//   node tools/dogfood-decide.mjs --campaign <dir> decide <fp> accepted|rejected|snoozed|merged
//                                 [--reason code] [--note text] [--into fp]
//   node tools/dogfood-decide.mjs --campaign <dir> outcome <DW-n> right|partly|wrong [--note text]
//   node tools/dogfood-decide.mjs --campaign <dir> rules                    rules offered and not yet decided
//   node tools/dogfood-decide.mjs --campaign <dir> rule <id> accepted|declined [--text wording]
//
// Decisions are made by `forge:campaign-team`. Output is JSON. Exit codes: 0 ok, 2 bad input (a refused tool call
// prints its error).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { callTool, emptyBackend } from './mock-forge-mcp.mjs';

const BY = 'forge:campaign-team';

/** @param {string} msg @returns {never} */
function usage(msg) {
  console.error(`dogfood-decide: ${msg}\nusage: node tools/dogfood-decide.mjs --campaign <dir> inbox|decide|outcome|rules|rule ...`);
  process.exit(2);
}

const argv = process.argv.slice(2);
/** @type {string[]} */
const pos = [];
/** @type {Record<string, string>} */
const f = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage(`${argv[i]} needs a value`);
    f[argv[i].slice(2)] = argv[++i];
  } else pos.push(argv[i]);
}
if (!f.campaign) usage('--campaign is required');
const stateFile = join(resolve(f.campaign), 'forge-state.json');
if (!existsSync(stateFile)) usage(`no campaign state at ${stateFile}; run tools/dogfood.mjs --campaign first`);
/** @type {any} */
const b = { ...emptyBackend(), ...JSON.parse(readFileSync(stateFile, 'utf8')) };

/** @param {string} name @param {Record<string, unknown>} args */
function call(name, args) {
  try { return callTool(b, name, args); } catch (e) {
    console.log(JSON.stringify({ error: /** @type {any} */ (e).code ?? 'error', message: /** @type {Error} */ (e).message }));
    process.exit(2);
  }
}

function save() {
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(b, null, 2));
  renameSync(`${stateFile}.tmp`, stateFile);
}

/** @param {Record<string, string | undefined>} o */
const present = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const [cmd, a1, a2] = pos;
switch (cmd) {
  case 'inbox': {
    const items = Object.values(b.projects).flatMap((/** @type {any} */ p) => Object.values(p.items ?? {}))
      .filter((/** @type {any} */ it) => !f.status || it.status === f.status)
      .map((/** @type {any} */ it) => present({ ref: it.external_ref, fp: it.fp, lens: it.record?.lens, status: it.status,
        reopened: it.reopened ? 'yes' : undefined, title: it.record?.title, issue: it.issue_ref }));
    console.log(JSON.stringify({ items }, null, 2));
    break;
  }
  case 'decide': {
    if (!a1 || !a2) usage('decide <fp> <status>');
    console.log(JSON.stringify(call('mock_decide', present({ fp: a1, status: a2, reason: f.reason, note: f.note, merged_into: f.into, decided_by: BY }))));
    save();
    break;
  }
  case 'outcome': {
    if (!a1 || !a2) usage('outcome <DW-n> right|partly|wrong');
    console.log(JSON.stringify(call('mock_outcome', present({ ref: a1, rating: a2, note: f.note, decided_by: BY }))));
    save();
    break;
  }
  case 'rules': {
    const rules = Object.entries(b.projects).flatMap(([key, /** @type {any} */ p]) => Object.values(p.rules ?? {})
      .filter((/** @type {any} */ r) => r.state === 'offered').map((/** @type {any} */ r) => ({ project_key: key, id: r.id, lens: r.lens, text: r.text })));
    console.log(JSON.stringify({ rules }, null, 2));
    break;
  }
  case 'rule': {
    if (!a1 || !a2) usage('rule <id> accepted|declined');
    const key = Object.keys(b.projects).find((k) => b.projects[k].rules?.[a1]);
    if (!key) usage(`no offered rule ${a1}`);
    console.log(JSON.stringify(call('mock_decide_rule', present({ project_key: key, id: a1, state: a2, text: f.text, decided_by: BY }))));
    save();
    break;
  }
  default:
    usage(`unknown command ${cmd ?? '(none)'}`);
}
