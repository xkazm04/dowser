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
/** Programs other than dowser.mjs that the procedure names with flags (`git log --since`, `node --version`). */
const EXTERNAL = new Set(['git', 'node', 'npm', 'npx']);

/** The words of a backticked span, with a leading `dowser.mjs` or `node <path>/dowser.mjs` removed. @param {string} span */
function spanWords(span) {
  const words = span.trim().split(/\s+/);
  if (words[0] === 'node' && /dowser\.mjs$/.test(words[1] ?? '')) words.splice(0, 2);
  else if (/dowser\.mjs$/.test(words[0])) words.splice(0, 1);
  return words;
}

/**
 * Every backticked span that starts with a dowser command (optionally after `dowser.mjs` or `node <path>/dowser.mjs`),
 * checked against COMMANDS: a span with flags names a command that exists and declares each flag; a span naming a
 * subcommand names one that exists, flags or not. A span with flags whose first word is a bare name that is neither a
 * command nor an EXTERNAL program is a command the CLI no longer has (renamed or removed).
 * @param {string} text
 * @param {string} where
 * @returns {{problems: string[], checked: number}}
 */
export function checkInvocations(text, where) {
  /** @type {string[]} */
  const problems = [];
  let checked = 0;
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const words = spanWords(m[1]);
    const cmd = words[0];
    const flags = words.filter((w) => /^\[?--[a-z]/.test(w)).map((w) => w.replace(/^\[?--/, '').replace(/[=\]].*$/, ''));
    if (!cmd) continue;
    if (!Object.hasOwn(COMMANDS, cmd)) {
      if (flags.length && /^[a-z][a-z-]*$/.test(cmd) && !EXTERNAL.has(cmd)) problems.push(`${where}: \`${m[1]}\` - no command ${cmd}`);
      continue;
    }
    /** @type {any} */
    let entry = COMMANDS[cmd];
    let path = cmd;
    if (entry.subs) {
      const sub = words[1];
      if (!flags.length && (!sub || !/^[a-z][a-z-]*$/.test(sub))) continue;
      checked++;
      if (!sub || !Object.hasOwn(entry.subs, sub)) { problems.push(`${where}: \`${m[1]}\` - ${cmd} has no subcommand ${sub}`); continue; }
      entry = entry.subs[sub];
      path = `${cmd} ${sub}`;
    } else {
      if (!flags.length) continue;
      checked++;
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

test('a procedure naming a command the CLI no longer has fails, with or without flags on a subcommand', () => {
  assert.deepEqual(checkInvocations('Run `pretriagex --run x`.', 'f').problems, ['f: `pretriagex --run x` - no command pretriagex']);
  assert.deepEqual(checkInvocations('Run `rules offers`.', 'f').problems, ['f: `rules offers` - rules has no subcommand offers']);
  assert.deepEqual(checkInvocations('`git log --since=90.days` and `node --version`, `rules offer`, `triage`', 'f').problems, []);
});

test('every CLI command and subcommand is named in SKILL.md, a reference or a lens pack', () => {
  /** @type {Set<string>} */
  const named = new Set();
  for (const file of docs()) {
    for (const m of readFileSync(file, 'utf8').matchAll(/`([^`\n]+)`/g)) {
      const [cmd, sub] = spanWords(m[1]);
      if (!cmd || !Object.hasOwn(COMMANDS, cmd)) continue;
      /** @type {any} */
      const entry = COMMANDS[cmd];
      named.add(entry.subs && sub && Object.hasOwn(entry.subs, sub) ? `${cmd} ${sub}` : cmd);
    }
  }
  /** @type {Record<string, any>} */
  const commands = COMMANDS;
  const all = Object.entries(commands).flatMap(([k, e]) => (e.subs ? Object.keys(e.subs).map((s) => `${k} ${s}`) : [k]));
  assert.deepEqual(all.filter((c) => !named.has(c)), [], 'commands the agent is never told about');
});

test('the lens order in SKILL.md section 5 is LENSES, and every pack loads', () => {
  const text = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const m = text.match(/The lenses, in this order: ([^.]+)\./);
  assert.ok(m, 'section 5 states the lens order');
  assert.deepEqual([...m[1].matchAll(/`([a-z-]+)`/g)].map((x) => x[1]), [...LENSES]);
  for (const lens of LENSES) assert.equal(loadLensPack(lens).id, lens);
});

test('every --focus value SKILL.md tells the agent to pass is one run start accepts (no space after the colon)', () => {
  const md = readFileSync(join(SKILL, 'SKILL.md'), 'utf8');
  const values = [...md.matchAll(/--focus "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 2, 'SKILL.md names the goal and area forms');
  for (const v of values) assert.match(v, /^(goal|area):\S/, `--focus "${v}" is refused by run start`);
});
