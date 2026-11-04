// @ts-check
// The agent's procedure (SKILL.md, references/*.md and the lens packs) may only name CLI commands and flags the
// CLI declares, and its lens order is the code's. A renamed flag or kind fails here, not in a live run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../dowser.mjs';
import { LENSES } from '../lib/model.mjs';
import { loadLensPack } from '../lib/memory.mjs';

const SKILL = fileURLToPath(new URL('../../', import.meta.url));
const GLOBAL = ['repo', 'help'];

/**
 * Every backticked span that starts with a dowser command (optionally after `dowser.mjs` or `node <path>/dowser.mjs`)
 * and names a flag, checked against COMMANDS: the command (and its subcommand) exists and declares each flag.
 * @param {string} text
 * @param {string} where
 * @returns {{problems: string[], checked: number}}
 */
export function checkInvocations(text, where) {
  /** @type {string[]} */
  const problems = [];
  let checked = 0;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const words = m[1].trim().split(/\s+/);
    if (words[0] === 'node' && /dowser\.mjs$/.test(words[1] ?? '')) words.splice(0, 2);
    else if (/dowser\.mjs$/.test(words[0])) words.splice(0, 1);
    const cmd = words[0];
    if (!cmd || !Object.hasOwn(COMMANDS, cmd)) continue;
    const flags = words.filter((w) => /^\[?--[a-z]/.test(w)).map((w) => w.replace(/^\[?--/, '').replace(/[=\]].*$/, ''));
    if (!flags.length) continue;
    checked++;
    /** @type {any} */
    let entry = COMMANDS[cmd];
    let path = cmd;
    if (entry.subs) {
      const sub = words[1];
      if (!sub || !Object.hasOwn(entry.subs, sub)) { problems.push(`${where}: \`${m[1]}\` - ${cmd} has no subcommand ${sub}`); continue; }
      entry = entry.subs[sub];
      path = `${cmd} ${sub}`;
    }
    for (const f of flags) {
      if (!GLOBAL.includes(f) && !Object.hasOwn(entry.flags ?? {}, f)) problems.push(`${where}: \`${m[1]}\` - ${path} declares no --${f}`);
    }
  }
  return { problems, checked };
}

/** Everything the agent reads: SKILL.md, the references and the lens packs. */
const docs = () => [join(SKILL, 'SKILL.md'), ...['references', 'lenses'].flatMap((d) => readdirSync(join(SKILL, d)).filter((f) => f.endsWith('.md')).map((f) => join(SKILL, d, f)))];

test('every invocation in SKILL.md, references and lens packs names a declared command and flag', () => {
  let total = 0;
  /** @type {string[]} */
  const problems = [];
  for (const file of docs()) {
    const r = checkInvocations(readFileSync(file, 'utf8'), file.slice(SKILL.length));
    total += r.checked;
    problems.push(...r.problems);
  }
  assert.deepEqual(problems, []);
  assert.ok(total >= 20, `invocations checked: ${total}`);
});

test('a procedure naming a flag the command lacks fails the check', () => {
  const text = `${readFileSync(join(SKILL, 'SKILL.md'), 'utf8')}\nThen run \`verify --run x --bogus\`.\n`;
  const r = checkInvocations(text, 'fixture');
  assert.deepEqual(r.problems, ['fixture: `verify --run x --bogus` - verify declares no --bogus']);
  assert.equal(checkInvocations('`run begin --run x`', 'f').problems.length, 1, 'an unknown subcommand fails too');
});

test('the lens order in SKILL.md section 5 is LENSES, and every pack loads', () => {
  const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const m = text.match(/The lenses, in this order: ([^.]+)\./);
  assert.ok(m, 'section 5 states the lens order');
  assert.deepEqual([...m[1].matchAll(/`([a-z-]+)`/g)].map((x) => x[1]), [...LENSES]);
  for (const lens of LENSES) assert.equal(loadLensPack(lens).id, lens);
});
