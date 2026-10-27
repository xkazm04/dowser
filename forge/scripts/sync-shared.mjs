#!/usr/bin/env node
// @ts-check
// sync-shared - copy the skill's pure modules into forge/src/shared/ byte for byte (design F6). Forge bundles
// from the app root, so the app cannot import ../skill directly; a copy plus a check keeps one source of truth.
//
//   node scripts/sync-shared.mjs [--check]
//     --check  change nothing; exit 1 when a copy differs from its source.
//
// Exit codes: 0 in sync (or synced), 1 a copy differs (--check), 3 a source file is missing.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'skill', 'scripts', 'lib');
const DST = join(HERE, '..', 'src', 'shared');
/** Pure modules only: no node:sqlite, no fs, no child_process. */
export const SHARED = ['model.mjs', 'fingerprint.mjs'];

/** @param {boolean} check @returns {number} exit code */
function sync(check) {
  let differ = 0;
  for (const name of SHARED) {
    const from = join(SRC, name);
    const to = join(DST, name);
    if (!existsSync(from)) {
      console.error(`sync-shared: missing source ${from}`);
      return 3;
    }
    const want = readFileSync(from);
    const have = existsSync(to) ? readFileSync(to) : undefined;
    if (have && have.equals(want)) continue;
    if (check) {
      console.error(`sync-shared: ${name} differs from skill/scripts/lib/${name}; run npm run sync-shared`);
      differ++;
    } else {
      writeFileSync(to, want);
      console.log(`sync-shared: copied ${name}`);
    }
  }
  return differ ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(sync(process.argv.includes('--check')));
}
