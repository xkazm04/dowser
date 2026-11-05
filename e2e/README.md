# e2e - the growing browser harness

Playwright specs over the Dowser Custom UI, in three projects. Config: `playwright.config.mjs` at the repo root.
`@playwright/test` is a root devDependency pinned to 1.64.1, whose Chromium build (1248) is the one already in
the Playwright browser cache, so no browser download is needed. If the cache lacks it, run
`npx playwright install chromium` once. A clean checkout needs `npm ci` and `npm ci --prefix forge/static/app`
(the Vite dev server); the local project needs nothing more, because `tools/local-forge.mjs` imports only Node built-ins.

| project | what it drives | start it |
|---|---|---|
| `fixture` | `vite --mode fixture`: the in-memory fixture bridge (`forge/static/app/src/dev/bridge.js`), the only place error, empty and slow states can be forced | `npm run e2e:fixture` |
| `local` | the real Forge core (`tools/local-forge.mjs --http 0 --reset --seed e2e/local/seed.json` on a temp db) behind `vite --mode local-forge` | `npm run e2e:local` |
| `live` | the deployed app on the Jira development site, in the persistent profile `~/.temper/chrome-profile` | `npm run e2e:live` |

`npx playwright test --project fixture` (or `local`, `live`) works the same way. The suites run headless on Windows.
`e2e/global-setup.mjs` starts only what the selected projects need, each on a port it finds free at run time (never
4710 or 5173). It passes the URLs to the specs in `E2E_FIXTURE_URL`, `E2E_LOCAL_URL`, `E2E_LOCAL_FORGE` and
`E2E_LOCAL_DB`, and stops every server with its whole process tree when the run ends, failed or not.

The local project pushes the bundled self-scan (`forge/src/sample/self-scan.json`) over MCP into the inbox
`github-com-xkazm04-dowser-e2e-local`. The sample key is reserved, so it uses its own key. It also sets that inbox's
Accept target to the local Jira project `DOW`. The triage spec pushes a fresh inbox per run, so retries and
`--repeat-each` copies never meet a card that an earlier run decided. It asserts each decision on the other two doors:
`GET /dev/state` and `/browse/<key>` on the HTTP server, and `dowser_verdicts_pull` through a second, short-lived
`local-forge --stdio` on the same db.

## Results: three states

Each run writes `e2e/results/<project>.json` (gitignored, with the screenshots in `e2e/results/screens/<project>/` and
the traces of failures in `e2e/results/artifacts/`):

```json
[{"spec": "e2e/fixture/surfaces.spec.mjs > surface inbox renders its key element", "state": "pass", "attempts": 1, "flaky": false}]
```

- `state` is `pass`, `fail` or `unverifiable`. A spec that cannot reach what it checks calls `unverifiable(why)`
  (`e2e/lib/guard.mjs`). For example, the live profile is signed out, or there is no profile. The spec then skips
  with an `unverifiable` annotation. It is never counted as a pass, and never as a fail, so the runner's exit code
  stays 0. A plain skip is not a result and is left out.
- `attempts` counts the runs over retries (`retries: 1`; `live` has 0) and `--repeat-each` copies.
- `flaky` is true when a spec passed only on a retry, or passed and failed across repeats. To check the stability bar
  ("none flaky over 3 runs"), use `npx playwright test --project <p> --repeat-each 3`.

Every spec fails on a console error or an uncaught page error (`consoleGuard`, an automatic fixture). On `live`, only
console errors from the Dowser iframe count, because Jira's own console is not the app's.

## The live project

Sign in once: `node e2e/live/sign-in.mjs` opens the profile headed at the inbox. Close the window when the inbox
shows. The specs then use that profile. Each flow opens its own persistent context, brings the page to the front, and
turns on focus emulation (`Emulation.setFocusEmulationEnabled`). It clicks the sidebar items with a DOM `click()`,
because Jira's sidebar ignores a synthetic pointer sequence. Every wait has a hard timeout (45 s per step, 120 s per
spec). The specs only read: the Accept dialog's issue preview is cancelled, never submitted.

Environment overrides: `E2E_LIVE_PROFILE`, `E2E_LIVE_SITE`, `E2E_LIVE_APP` (the global page URL without the route),
`E2E_LIVE_REF` (an open inbox item, default `DW-3`), `E2E_LIVE_HEADLESS=1`.

The live selectors for the Forge iframe (`iframe[src*="atlassian-dev.net"]`) and the sidebar links (by their manifest
`pages` titles) are unconfirmed on a signed-in profile. Confirm them on the first signed-in run. Until then, the
live suite has only been checked signed out, where it reports `unverifiable`.

## Coverage: `@covers` tags and the baseline

`npm run e2e:coverage` (`tools/e2e-coverage.mjs`) lists every id that the app's own sources define. It also lists the
spec lines that cover each one:

| id | derived from | covered when a spec |
|---|---|---|
| `route:<page>` | `forge/manifest.yml` `jira:globalPage` `pages` routes | renders that tab |
| `route:<module>` | `forge/static/app/src/router.jsx` `MODULES` keys | renders that module's surface |
| `resolver:<key>` | `forge/src/core/app.mjs` `RESOLVERS` | sees the key's success answer on the page, or reads it back |
| `fail:<key>` | the same keys | forces `&fail=<key>` and sees the failure on the surface that calls it |
| `fixture:<name>` | `params().get/has('<name>')` in `src/dev/bridge.js`, and `LINK_KEYS` in `src/dev/link.js` | exercises that hash parameter |

A spec claims coverage with a comment line `// @covers <id> [<id> ...]` directly above the test, or above the table
entry it generates. Any other id kind (`live:sidebar`, `live:issue-preview`) is free-form. Free ids are listed under
`free` but never gated. An unknown id of a derived kind fails the tool, so a typo cannot pass for coverage. Tag a
`resolver:` id only where the success path really runs. A failure case gets `fail:` only.

`e2e/coverage-baseline.json` (`{"uncovered": [ids]}`) lists the ids allowed to stay uncovered. Today it is empty.
The tool exits 1 when:

- an id is uncovered and not in the baseline. New code needs a spec, not a baseline line.
- a baseline id is covered now, or no longer exists (`stale`). Shrink the baseline with `--write`.
- the baseline lists an id that it did not list at `--against` (default `HEAD`; `none` skips). The baseline may only
  shrink.

`npm test` runs the tool on the repository (`skill/scripts/tests/e2e-coverage.test.mjs`), so a new resolver key, a
route or a fixture condition without a spec fails the test gate.

## Growing it

To add a surface, a resolver or a fixture condition, write the spec and its `@covers` line in the same change. Put
fixture-only states (errors, empty, slow, deep links) in `e2e/fixture/`. Put writes that the skill reads back in
`e2e/local/`. Use `screen(page, name)` for a primary-viewport screenshot of every new state.
