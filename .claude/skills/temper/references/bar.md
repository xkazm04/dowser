# The stability bar

One measured bar, applied module by module (`modules.json`: 8 modules over the context map and the lens-scan
supplement). `T modules bar` reads every part from an instrument and writes `docs/evals/temper/modules.json`.

| part | instrument | met when |
|---|---|---|
| `uat` | `e2e/results/<project>.json` (the runner's three-state rows), matched to the module's surfaces by the `uat` regexes; a CLI-only module (`"uat": "tests"`) reads the gates of the last quality-snapshot row | every matched spec passes, none flaky, each run at least 3 times (`--repeat-each 3`), on every project the module renders in |
| `proposals` | the lens-scan store (its `store.mjs proposals`, read-only), `.ai/lens-scan/app-structure.json` (feature -> contexts) and `docs/evals/temper/resolved.json` | no open proposal (proposed, approved, executing, failed, rework, done) at tier 0-2 on the module's features, other than one resolved by a landed commit |
| `scan_yield` | `~/.temper/scans.jsonl`, rows of the Dowser inbox with the module's `focus` | the last two scans each created 2 cards or fewer |
| `quality` | `docs/evals/temper/quality.jsonl` (quality-snapshot rows) | long_functions, dup_windows, lib_cycles and todos did not grow between the last two rows |
| `coverage` | `tools/e2e-coverage.mjs` | every route and resolver id matched by the module's `coverage` regexes is covered by a spec |

Each part is `{state, ok, detail}`:

- `verified` means the value came from a tool's own output.
- `self-reported` means only the director's cycle rows claim it (scan counts without ledger rows).
- `unverifiable` means the instrument is missing, stale (e2e results older than HEAD), signed out (live), or cannot
  tell (an untriaged lens proposal).

A module meets the bar only when all five parts are `verified` and ok. Self-reported and unverifiable never count as
a pass. `next` is the module with the fewest verified parts held, which the next cycle targets.

The quality part reads a repo-wide snapshot, so it is the same for every module until quality-snapshot breaks its
counts down by area. Live UAT stays unverifiable until the operator signs in. Until then, no UI module meets the bar,
on purpose.

### A proposal whose fix already landed

The lens-scan store keeps a proposal `proposed` until a person decides it, and its statuses belong to lens-scan and the
operator, so the loop never writes them. A fix that landed some other way (p-a3b5bd, the install.mjs git option
injection, fixed in v0.3.0) would hold the module below the bar for good. Record it instead:

```
T proposals resolve --id p-a3b5bd --commit <sha of the fix> [--note "fixed in v0.3.0"]
```

It refuses a commit that is not on HEAD's history, an id the store does not hold (when the store is readable), and a
proposal that lens-scan is executing. It writes `{commit, subject, resolved_at, by, status_then, tier, note?}` to
`docs/evals/temper/resolved.json`; commit that file with the cycle record. The bar drops a resolved proposal from the
open ones while its commit is still an ancestor of HEAD (a reset or a red day's rollback brings it back), and the
part's detail names each one with its commit, so the morning report shows it. Only the commit's presence is checked:
that the commit fixes the proposal is the director's claim, so resolve only after reading the fix against the
proposal's evidence. The proposal stays `proposed` in the store for the operator to close.

When a context is added to the map, add it to a module. When a route or resolver key is added, make sure a module's
`coverage` matches it. `skill/scripts/tests/temper.test.mjs` fails until both hold.
