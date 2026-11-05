# Expansion: directions and new lenses

The doctrine is to stabilize first, then expand. No product is ever perfect, so the loop also looks for the next
valuable direction, but only for a module at the bar.

## Direction proposals

- A module that meets the bar (`modules bar` -> `met: true`) may get up to **3** pending direction proposals. A
  proposal is `{id, module, title, evidence, value, size, first_slice}` in the cycle file's `directions`.
  - `evidence` is quoted (a code path, a card, a Jira ticket, a UAT finding).
  - `value` says who gains and how.
  - `size` is XS-XL.
  - `first_slice` is the smallest gated slice that proves it.
- `cycle end` refuses a direction for a module below the bar, and a fourth pending direction for one module.
- The next morning's report lists them. The operator picks, reorders or vetoes them in the start dialog
  (`day start --approve/--veto`). An approved direction becomes a target: `cycle begin --target direction:<id>`. Its
  focus is `goal:<title>`.
- The loop never approves its own direction.

## New lenses

A direction-finding lens, or any new lens, is drafted with lens-scan onboard and measured with `node tools/lens-eval.mjs`
on the lens fixture before it is enabled. A lens that does not hold its band on the fixture stays off. A new lens's
first live scan is a cycle of its own, so its yield is visible in the ledger.
