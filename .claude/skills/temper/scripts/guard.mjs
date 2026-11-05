#!/usr/bin/env node
// @ts-check
// guard - the /temper trust boundary as a Claude Code PreToolUse hook (.claude/settings.json, matcher
// Bash|PowerShell|Write|Edit). It reads the hook JSON on stdin ({tool_name, tool_input, cwd}) and prints a decision,
// or nothing to let the call through (the hooks contract: hookSpecificOutput.permissionDecision deny | ask).
//
// Denied, in every repo:
//   - a write to <project>/.temper/charter.json (Write, Edit, or a shell command naming it), and removing .temper/;
//   - `temper.mjs charter init` and `temper.mjs day start --approve/--veto`, unless the whole command is the start
//     dialog's exact form: `TEMPER_CHARTER_DIALOG=1 node <..>temper.mjs <charter init|day start> <flags>` (bash) or
//     `$env:TEMPER_CHARTER_DIALOG='1'; node <..>temper.mjs ...` (PowerShell). That form is not silently allowed: it is
//     answered `ask`, so the operator confirms the charter in person;
//   - `forge deploy` to production, or with no -e at all (the CLI's default environment could be production), and
//     `forge install` to production;
//   - `git tag` other than listing, `gh release` other than list/view/download;
//   - `git push` with --force/-f/--force-with-lease/--delete/-d/--mirror/--all/--tags/--follow-tags/--prune/--no-verify,
//     a `+` or `:dst` (delete) refspec, no refspec, or a destination the repo's landing does not permit. The repo is
//     the `git -C` dir or the shell's cwd (cd/Set-Location in the command are followed); its permitted refspecs are the
//     charter's repos[].landing.push (defaults: loop-ff master + loop/*, rebase-push master, commit-only none). Without a
//     charter only the project (Dowser) may push, to master and loop/*. A push from a repo outside the charter is denied.
// Nested shells (bash -c, powershell -Command, cmd /c, eval) are read too. Quoted arguments of other commands (a
// commit message naming `git push -f`) are data, not commands.
// Self-test: the table in skill/scripts/tests/temper.test.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The refspecs each landing kind may push to (the same table as temper.mjs LANDINGS; a test keeps them equal). */
export const PUSH_DEFAULTS = { 'loop-ff': ['master', 'loop/*'], 'rebase-push': ['master'], 'commit-only': [] };
const PUSH_DENY_FLAGS = new Set(['-f', '--force', '--delete', '-d', '--mirror', '--all', '--tags', '--follow-tags', '--prune', '--no-verify', '--force-if-includes']);
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
const TAG_WRITE_FLAGS = new Set(['-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-d', '--delete', '-f', '--force', '-m', '--message', '-F', '--file', '-e', '--edit']);
const READ_VERBS = /^\s*(?:cat|type|Get-Content|gc|head|tail|less|more)\s+[^;&|<>`\n]*charter\.json['"]?\s*$/i;
const NODE_TEMPER = String.raw`node(?:\.exe)?\s+(?:"[^"\n]*temper\.mjs"|'[^'\n]*temper\.mjs'|[^\s"';&|]*temper\.mjs)\s+(?:charter\s+init|day\s+start)(?:\s+[^;&|<>\x60$\n]*)?\s*$`;
const DIALOG_BASH = new RegExp(String.raw`^\s*TEMPER_CHARTER_DIALOG=1\s+` + NODE_TEMPER);
const DIALOG_PS = new RegExp(String.raw`^\s*\$env:TEMPER_CHARTER_DIALOG\s*=\s*(['"]?)1\1\s*;\s*` + NODE_TEMPER, 'i');
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const PWSH = new Set(['powershell', 'pwsh']);
const PREFIXES = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'eval']);
const CD = new Set(['cd', 'set-location', 'sl', 'chdir', 'pushd', 'push-location']);
const RM = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'mv', 'move', 'move-item', 'rename-item', 'ren', 'mi', 'rni']);

/** @typedef {{projectDir: string, charter?: any, home: string}} GuardCtx  home: the Temper home (TEMPER_HOME, ~/.temper) */
/** @typedef {{decision: 'deny' | 'ask', reason: string} | undefined} Verdict */

/** @param {string} p */
const norm = (p) => resolve(p).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
/** @param {string} dir @param {string} root */
const inside = (dir, root) => { const d = norm(dir), r = norm(root); return d === r || d.startsWith(`${r}/`); };

/**
 * Splits a command line into segments of tokens. Quotes group (their content is one token, marked quoted); ; & | ( )
 * newlines and backticks separate. Backslashes are literal (Windows paths).
 * @param {string} s @returns {{t: string, q: boolean}[][]}
 */
export function segments(s) {
  /** @type {{t: string, q: boolean}[][]} */
  const out = [[]];
  let cur = '', q = false, has = false;
  const push = () => { if (has) out[out.length - 1].push({ t: cur, q }); cur = ''; q = false; has = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1);
      const end = j < 0 ? s.length : j;
      cur += s.slice(i + 1, end); q = true; has = true; i = end;
    } else if (/\s/.test(c) && c !== '\n') push();
    else if (';&|()\n`'.includes(c)) { push(); if (out[out.length - 1].length) out.push([]); }
    else { cur += c; has = true; }
  }
  push();
  return out.filter((x) => x.length);
}

/** @param {string} t */
const base = (t) => (t.split(/[\\/]/).at(-1) ?? t).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

/** The repo a push runs in, and the refspecs it may push to. @param {string} dir @param {GuardCtx} g */
function pushRules(dir, g) {
  const repos = Array.isArray(g.charter?.repos) ? g.charter.repos : undefined;
  if (!repos) return inside(dir, g.projectDir) ? { repo: 'dowser', allowed: PUSH_DEFAULTS['loop-ff'] } : undefined;
  for (const r of repos) {
    if (typeof r?.path !== 'string') continue;
    const wt = join(g.home, 'worktrees');
    const inWt = inside(dir, wt) && norm(dir).slice(norm(wt).length + 1).startsWith(`${String(r.name).toLowerCase()}-`);
    if (inside(dir, r.path) || inWt) {
      const kind = /** @type {keyof typeof PUSH_DEFAULTS} */ (r.landing?.kind ?? 'commit-only');
      return { repo: r.name, allowed: Array.isArray(r.landing?.push) ? r.landing.push : PUSH_DEFAULTS[kind] ?? [] };
    }
  }
  return undefined;
}

/** @param {string} dst @param {string[]} allowed */
const permitted = (dst, allowed) => allowed.some((a) => (a.endsWith('/*') ? dst.startsWith(a.slice(0, -1)) && dst.length > a.length - 1 : dst === a));

/** @param {string[]} args after `push` @param {string} dir @param {GuardCtx} g @returns {Verdict} */
function checkPush(args, dir, g) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const flag = a.split('=')[0];
    if (PUSH_DENY_FLAGS.has(flag) || flag.startsWith('--force') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) && !a.startsWith('--')) return { decision: 'deny', reason: `git push ${a}: never force, delete, mirror, push tags or skip hooks` };
    if (PUSH_VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const rules = pushRules(dir, g);
  if (!rules) return { decision: 'deny', reason: `git push from ${dir}: not a charter repo (only the charter's repos may push, each to its landing's branches)` };
  const refspecs = pos.slice(1);
  if (!refspecs.length) return { decision: 'deny', reason: 'git push without a refspec: name the branch (git push origin master)' };
  for (const r of refspecs) {
    if (r.startsWith('+')) return { decision: 'deny', reason: `git push ${r}: a + refspec forces` };
    const [src, dstRaw] = r.includes(':') ? r.split(':') : [r, r];
    if (!src) return { decision: 'deny', reason: `git push ${r}: an empty source deletes the remote branch` };
    const dst = dstRaw.replace(/^refs\/heads\//, '');
    if (dst === 'HEAD' || !permitted(dst, rules.allowed)) {
      return { decision: 'deny', reason: `git push to ${dst}: ${rules.repo}'s landing permits ${rules.allowed.length ? rules.allowed.join(', ') : 'no push at all'}` };
    }
  }
  return undefined;
}

/** The value of -e / --environment, or undefined when absent. @param {string[]} args */
function forgeEnv(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-e' || a === '--environment') return args[i + 1] ?? '';
    if (a.startsWith('--environment=')) return a.slice(14);
    if (a.startsWith('-e=')) return a.slice(3);
    if (/^-e\w/.test(a)) return a.slice(2);
  }
  return undefined;
}

/** @param {{t: string, q: boolean}[]} seg @param {{cwd: string}} st @param {GuardCtx} g @param {number} depth @returns {Verdict} */
function checkSegment(seg, st, g, depth) {
  let toks = seg.map((x) => x.t);
  while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || PREFIXES.has(toks[0].toLowerCase()) || toks[0] === '&' || /^\$env:/i.test(toks[0]))) {
    if (toks[0].toLowerCase() === 'eval') return analyze(toks.slice(1).join(' '), { ...st }, g, depth + 1);
    toks = toks.slice(1);
  }
  if (!toks.length) return undefined;
  const cmd = base(toks[0]);
  const args = toks.slice(1);
  if (CD.has(cmd)) {
    const target = args.find((a) => !a.startsWith('-'));
    if (target) st.cwd = isAbsolute(target) ? target : resolve(st.cwd, target.replace(/^~(?=$|[\\/])/, homedir()));
    return undefined;
  }
  if (SHELLS.has(cmd)) { const i = args.indexOf('-c'); return i >= 0 && args[i + 1] !== undefined ? analyze(args[i + 1], { ...st }, g, depth + 1) : undefined; }
  if (PWSH.has(cmd)) {
    const i = args.findIndex((a) => /^-(c|command)$/i.test(a));
    return i >= 0 ? analyze(args.slice(i + 1).join(' '), { ...st }, g, depth + 1) : undefined;
  }
  if (cmd === 'cmd') { const i = args.findIndex((a) => a.toLowerCase() === '/c'); return i >= 0 ? analyze(args.slice(i + 1).join(' '), { ...st }, g, depth + 1) : undefined; }
  if (RM.has(cmd)) {
    for (const a of args.filter((x) => !x.startsWith('-'))) {
      const p = isAbsolute(a) ? a : resolve(st.cwd, a);
      if (norm(p) === norm(join(g.projectDir, '.temper')) || norm(p) === norm(join(g.projectDir, '.temper', 'charter.json'))) return { decision: 'deny', reason: `${cmd} ${a}: the loop's state and its charter are not the session's to remove` };
    }
  }
  if (cmd === 'npx' || (cmd === 'npm' && args[0] === 'exec')) return checkSegment(seg.slice(cmd === 'npx' ? 1 : 2).filter((x) => x.t !== '--'), st, g, depth);
  if (cmd === 'git') {
    let dir = st.cwd, i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === '-C') { dir = isAbsolute(args[i + 1] ?? '') ? args[i + 1] : resolve(dir, args[i + 1] ?? '.'); i++; }
      else if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i++;
      else if (!a.startsWith('-')) break;
    }
    const sub = args[i], rest = args.slice(i + 1);
    if (sub === 'push') return checkPush(rest, dir, g);
    if (sub === 'tag') {
      const listing = !rest.length || rest.some((a) => a === '-l' || a === '--list' || a.startsWith('--list='));
      if (!listing || rest.some((a) => TAG_WRITE_FLAGS.has(a.split('=')[0]))) return { decision: 'deny', reason: 'git tag: tags are the operator\'s (only listing is allowed)' };
    }
    return undefined;
  }
  if (cmd === 'forge') {
    const sub = args.find((a) => !a.startsWith('-'));
    const env = forgeEnv(args);
    if (sub === 'deploy') {
      if (env === undefined) return { decision: 'deny', reason: 'forge deploy without -e: name the environment (-e development); the CLI\'s default could be production' };
      if (/^prod/i.test(env)) return { decision: 'deny', reason: 'forge deploy to production: production deploys are the operator\'s' };
    }
    if (sub === 'install' && env !== undefined && /^prod/i.test(env) && !args.includes('list')) return { decision: 'deny', reason: 'forge install to production is the operator\'s' };
    return undefined;
  }
  if (cmd === 'gh' && args[0] === 'release' && !['list', 'view', 'download'].includes(args[1] ?? '')) return { decision: 'deny', reason: 'gh release: releases are the operator\'s' };
  return undefined;
}

/** @param {string} command @param {{cwd: string}} st @param {GuardCtx} g @param {number} depth @returns {Verdict} */
function analyze(command, st, g, depth) {
  if (depth > 4) return { decision: 'deny', reason: 'nested shells too deep to check' };
  for (const seg of segments(command)) {
    const v = checkSegment(seg, st, g, depth);
    if (v) return v;
  }
  return undefined;
}

/**
 * The decision for one hook input.
 * @param {any} input @param {GuardCtx} g @returns {Verdict}
 */
export function decide(input, g) {
  const tool = String(input?.tool_name ?? '');
  const ti = input?.tool_input ?? {};
  const charterFile = join(g.projectDir, '.temper', 'charter.json');
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const fp = String(ti.file_path ?? ti.notebook_path ?? '');
    if (fp && norm(isAbsolute(fp) ? fp : resolve(input?.cwd ?? g.projectDir, fp)) === norm(charterFile)) {
      return { decision: 'deny', reason: '.temper/charter.json is written only by temper.mjs charter init in the start dialog' };
    }
    return undefined;
  }
  if (tool !== 'Bash' && tool !== 'PowerShell') return undefined;
  const command = String(ti.command ?? '');
  if (DIALOG_BASH.test(command) || DIALOG_PS.test(command)) {
    return { decision: 'ask', reason: 'The start dialog writes the charter or records direction answers: the operator confirms it in person.' };
  }
  if (/temper\.mjs/i.test(command) && (/\bcharter\s+init\b/i.test(command) || (/\bday\s+start\b/i.test(command) && /--(approve|veto)\b/i.test(command)))) {
    return { decision: 'deny', reason: 'charter init and direction answers run only in the start dialog\'s exact form (TEMPER_CHARTER_DIALOG=1 node .../temper.mjs ..., nothing chained)' };
  }
  if (/charter\.json/i.test(command) && !READ_VERBS.test(command)) {
    return { decision: 'deny', reason: '.temper/charter.json is written only by temper.mjs charter init in the start dialog (read it with temper.mjs charter show)' };
  }
  return analyze(command, { cwd: String(input?.cwd ?? g.projectDir) }, g, 0);
}

/** The guard's context for this project (home: the Temper home, where the build worktrees are). @param {NodeJS.ProcessEnv} env */
export function guardCtx(env) {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const projectDir = env.CLAUDE_PROJECT_DIR ?? here;
  const file = join(projectDir, '.temper', 'charter.json');
  let charter;
  try { charter = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined; } catch { charter = undefined; }
  return { projectDir, charter, home: resolve(env.TEMPER_HOME ?? join(homedir(), '.temper')) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input;
    try { input = JSON.parse(raw); } catch { return; }
    const v = decide(input, guardCtx(process.env));
    if (!v) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.decision, permissionDecisionReason: `temper guard: ${v.reason}` } }));
  });
}
