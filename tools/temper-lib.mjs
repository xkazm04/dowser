// @ts-check
// temper-lib - what the /temper tools (temper-scan, temper-tickets, temper-verdicts) share: the Temper home, the
// project-key rule a live inbox key must pass, and the usage error.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_KEY_RE } from '../forge/src/core/push.mjs';
import { SAMPLE_KEY } from '../forge/src/core/types.mjs';
import { normalizeRemote } from '../skill/scripts/lib/paths.mjs';

/** A bad command line (exit 2). */
export class UsageError extends Error {}

/** `~/.temper`, or TEMPER_HOME (tests). @param {NodeJS.ProcessEnv} [env] */
export const temperHome = (env = process.env) => resolve(env.TEMPER_HOME ?? join(homedir(), '.temper'));

/**
 * Checks a live inbox key and returns it. It must pass the push's rule (forge/src/core/push.mjs PROJECT_KEY_RE), must
 * not be the sample inbox's reserved key, and must survive the skill's remote normalization unchanged (lowercase, no
 * `--` run, no trailing `-`), because temper-scan hands it to the skill as the clone's origin.
 * @param {unknown} key
 * @returns {string}
 */
export function checkProjectKey(key) {
  if (typeof key !== 'string' || !PROJECT_KEY_RE.test(key)) throw new UsageError('--project-key must be 1-191 letters, digits or hyphens, starting with a letter or digit');
  if (key === SAMPLE_KEY) throw new UsageError(`--project-key ${SAMPLE_KEY} is reserved for the sample inbox`);
  if (normalizeRemote(key) !== key) throw new UsageError(`--project-key ${key} must be lowercase with single hyphens and no trailing hyphen (it would become ${normalizeRemote(key) || 'empty'})`);
  return key;
}

/**
 * Flags as `{name: value | true}`; `bool` names take no value, `multi` names repeat into arrays. Throws UsageError.
 * @param {string[]} argv @param {{values: string[], bool?: string[], multi?: string[]}} spec
 * @returns {{flags: Record<string, string | true>, multi: Record<string, string[]>, rest: string[]}}
 */
export function parseFlags(argv, spec) {
  /** @type {Record<string, string | true>} */
  const flags = {};
  /** @type {Record<string, string[]>} */
  const multi = {};
  /** @type {string[]} */
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const k = a.slice(2);
    const v = argv[i + 1];
    const hasValue = v !== undefined && !v.startsWith('--');
    if (spec.bool?.includes(k)) flags[k] = true;
    else if (spec.multi?.includes(k) && hasValue) { (multi[k] ??= []).push(v); i++; }
    else if (spec.values.includes(k) && hasValue) {
      if (k in flags) throw new UsageError(`${a} given twice`);
      flags[k] = v; i++;
    } else throw new UsageError(`unknown or valueless flag ${a}`);
  }
  return { flags, multi, rest };
}

/** True when the module at `url` is the script node was started with. @param {string} url */
export const isMain = (url) => Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(url);
