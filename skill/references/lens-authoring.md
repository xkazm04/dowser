# Authoring a lens pack

A lens is a versioned prompt pack plus evidence rules: one Markdown file in `lenses/`. The skill
reads its frontmatter for identity, kinds, sources and budget, and its body for the method. The
fingerprint uses `lens` and `kind`, so these are a contract with every past scan of every
project. Change them only as described below.

## Frontmatter

```yaml
---
id: opportunity
version: 0.1.0
name: Opportunity
kinds: [expose-capability, extend-capability, missing-capability, goal-gap, workflow-shortcut]
sources: [code, docs, git, tickets, goals]
optional_sources: []
requires_connection: true
budget: 4
---
```

| Field | Rule |
| --- | --- |
| `id` | Kebab-case, unique. It goes into every proposal's `lens` and fingerprint. |
| `version` | Semver. It is recorded in every proposal's `provenance.lens_version`. |
| `name` | The display name. |
| `kinds` | A closed list of 3-6 kebab values. The fingerprint includes `kind`, so each value is a promise. |
| `sources` | A subset of `code`, `docs`, `git`, `tickets`, `pages`, `goals`, `deps`, `sarif`. |
| `optional_sources` | Sources whose absence does **not** make the lens partial (for example `sarif`, which only exists if the runner supplies it). Defaults to `[]`. |
| `requires_connection` | `true` when the lens's central hypotheses need Jira or Confluence data. Unconnected, it still runs, as `partial`, with `confidence: low` on every candidate. |
| `budget` | Proposals per run. Fixed at 4 in v0.1, and not learned. |

Frontmatter is ASCII. Keep values on one line, because the parser reads a small YAML subset.

### Source availability decides the lens state

- `tickets`, `pages`, `goals` need the Forge connection. `code`, `docs`, `git`, `deps` come from
  the checkout. `sarif` comes from a file the runner names.
- Any listed source that is unavailable and not in `optional_sources` makes the lens `partial`,
  with a reason that names the source and the hypotheses it left unchecked.
- A lens is `skipped` only when it has no surface at all (for example no UI code for UX
  friction), with that reason.

Sources map to evidence types: `docs` -> `doc`, `deps` -> `dep`. The others keep their names
(`tickets` -> `ticket`, `pages` -> `page`, `goals` -> `goal`).

## Body - required sections

1. **What it finds**: one paragraph, plus the example the product plan gives.
2. **Gather**: concrete steps. Name the globs, the greps, the git commands, and the MCP tools
   with the query to send. Tolerant: say what to record when a step yields nothing.
3. **Hypotheses**: a numbered list (`H1`...). The lens only gets coverage for a hypothesis it
   pointed at something. The run's lens report names the hypotheses checked.
4. **Evidence rules**: what each kind must cite, beyond `references/cards.md`.
5. **Topic naming**: how to build the stable `topic` slug.
6. **Examples**: two or more candidate lines, as a `jsonl` code block: one per supporting view
   the pack maps, plus one with no view. Each must pass `propose`'s validation (title 80
   characters or fewer, five body sections, quotes on code and doc evidence, `artifacts`
   within the contract).
7. **No finding**: the exact form of a lens report with zero proposals.

Keep a pack under 200 lines. Long background belongs in a separate `references/` file that the
pack names.

## Versioning

- **Patch** (`0.1.0` -> `0.1.1`): wording, gather tweaks, a new hypothesis. Fingerprints are
  unchanged.
- **Minor** (`0.1.x` -> `0.2.0`): a new `kind` added, a new source. Old fingerprints stay
  valid, and new kinds create new ones.
- **Major** (`0.x` -> `1.0.0`): a `kind` renamed or removed, or the topic rule changed. Old
  items no longer match. Say so in the pack's changelog line, and expect a burst of "new"
  proposals on the next scan.

Add a one-line changelog at the bottom of the body for every version.

## Forking a lens for a team

1. Copy the pack: `lenses/ux-friction.md` -> `lenses/ux-friction-acme.md`.
2. Set a new `id` with a suffix: `ux-friction-acme`. A fork is a different lens: its proposals
   and fingerprints are separate from the original's.
3. Reset `version` to `0.1.0` in the fork, or bump the original's version if you are editing in
   place rather than forking.
4. Change kinds, hypotheses or gather steps. Keep the seven body sections.
5. Add the fork to the skill's lens order in `SKILL.md` section 5, and pass it to `propose` with
   `--kinds <fork-id>=<its kinds>`.

The store's lens enum in v0.1 names the four built-in lenses. Registering a fork's `id` with
the store is a planned addition. Until it lands, fork by editing a built-in pack in place, with
a version bump.

## How accepted rules attach

Rules are not edited into the pack file. When the runner accepts a rule offer, the store keeps
it with its provenance (cluster, who accepted it, when). `context --lens <id>` returns it in
`rules`, and the agent applies it as binding on top of the pack. To make a rule permanent for
everyone who uses the pack, copy its text into the pack's hypotheses or evidence rules, bump
`version` (patch), and note the rule id in the changelog line.

## Measuring a lens

Every pack change is measured before and after, on a seeded fixture, so a "better" pack is a
number and not an impression.

- **The fixture** is `scripts/tests/fixtures/lens-fixture/`: a small web shop (checkout with a
  payment step, an admin CLI, README and `docs/`, a lockfile pinning a package with known
  advisories). `_expected.json` lists, per lens, 6-8 **seeded** findings (taken from the pack's
  hypotheses), more than the pack's budget of 4, so a lens is judged on choosing well and not
  only on finding. Each has a `priority`: 1 must be in the top 4, 2 is good, 3 is minor, from
  the impact its evidence shows (ticket counts and spread, user-facing or internal, severity).
  At least one priority-1 finding per lens only shows its strength through connected sources:
  ticket labels, components and dates (opportunity, ux-friction), a Confluence page in a named
  space (doc-drift), or `dowser deps` output (security-cra). Each lens also has 3-5 **decoys**:
  code that a careless read proposes but that is not a finding, such as a doc that is correct
  for a still-supported version, demand a past release already met, an error that does
  recover, a test-only key, or a vulnerable package that is dev-only and never shipped.
  `_sources.json` seeds the mock Forge with tickets, pages, goals and a team **direction** per
  lens: its focus should pull the item marked `focus_by_direction` (priority 2) into the top 4,
  and its exclude rules out the item marked `excluded_by_direction`, which must not be
  proposed. `_auditor/npm-audit.json` is captured audit output; `_history/commits.json` replays
  a short git history. Files starting with `_` never reach the scanned copy, and nothing in the
  scanned files says it is a test.
- **Run it** from the repository root: `node tools/lens-eval.mjs --lens <id> [--model <m>]`.
  It copies the fixture to a temp folder, makes it a git repo, gives it a temp `DOWSER_HOME`,
  connects the mock Forge, runs one headless Claude Code scan of that lens only, scores the
  cards and appends one row to `~/.dowser/evals.jsonl` (`--evals <file>` to change it).
  The mock answers `dowser_direction_get` with the fixture's direction, re-keyed to the temp
  copy's project key. `--dry-run` builds the workspace and prints the plan, including the
  direction the mock will answer for the lens, without calling Claude. A real run costs
  tokens.
- **The numbers.** A card counts for the one expected item its anchors land on most strongly.
  The headline is `recall_at_budget`: seeded items found over the smaller of the seeded count
  and the pack's budget, so 1 means every card was spent on a real finding. Read it with
  `priority1_found` of `priority1_total` (a lens that fills its budget with minor findings
  scores well on recall and badly here) and `focus_found` of `focus_total` (whether the team's
  focus moved the choice). `recall` is seeded items found over all seeded items; with more
  findings than the budget it cannot reach 1 and is kept for comparison. `precision` is cards
  on a seeded item over cards that survived `verify`; a card on nothing expected counts
  against it and is listed under `unmatched` so you can judge it by hand. `decoy_hits` is
  cards on a decoy and `direction_violations` cards on an item the direction excludes; both
  should be 0 and both count against precision. `artifacts_valid` of `artifacts_total` is how
  many supporting views pass validation, and `verify_dropped` is how many cards `verify`
  removed. A value that was not measured is left out, never 0: no `precision` when nothing was
  emitted, no `recall_at_budget` when the pack names no budget. Rows from before
  `fixture_version` 2 lack the budget signals and were measured on an easier fixture; compare
  a pack only with rows of the same `fixture_version`.
- **What the fixture does not prove.** The fixture tests the pack's mechanics on findings its
  author planted. Precision that matters is measured on a real repository: hand-verify a
  sample of 10 cards (or all, if fewer) and count the true ones.
- **Record it.** The pack's changelog line for the new version states both: the fixture
  score and the hand-verified precision, each with its `n` and date, for example
  `0.2.0 - direction, artifacts; fixture v2 recall@4 4/4, priority-1 3/3, 0 decoys, 0 direction
  violations (2026-11-02); precision 8/10 on acme-shop (2026-11-03)`. If `recall_at_budget` or
  `priority1_found` falls, or a decoy or excluded item is hit, explain why in that changelog
  line before the pack ships.
