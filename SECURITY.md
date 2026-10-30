# Security policy

## Reporting a vulnerability

Report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for a security problem.

Please include what is affected (the skill, its scripts, or the Dowser for Jira Forge app), the version or
commit, and the steps that show the problem. We acknowledge a report within 5 working days and tell you what
we will do about it.

## Supported versions

Dowser is pre-release (0.x). A release is a `vMAJOR.MINOR.PATCH` git tag; its version is the `version:` of
`skill/SKILL.md`, and the root `package.json` carries the same number. Security fixes land on `master` and
ship in the next release; only the newest release receives them, so an older 0.x install is fixed by
updating. Until the first release is tagged, only the latest commit on `master` receives security fixes. A
support period for 1.x will be stated here before 1.0 is tagged.

## Keeping an installed copy up to date

`node skill/install.mjs` copies the skill into the harness folder, and the copy does not change when the
repository does. Each copy records what it was installed from in `install.json` beside its `SKILL.md`:
the version, the source commit, whether the skill folder had uncommitted changes, and the repository's
`origin` URL with any credentials removed. A `--dev-link` install is a link to the checkout and records
nothing; it follows whatever the checkout holds.

To find out whether a newer release exists, run from a Dowser checkout:

```
node skill/install.mjs --check --harness claude      # or codex; add --scope project for a project install
```

It reads the installed copy's version and lists the release tags of the repository it came from
(`git ls-remote --tags`; `--from <url or path>` names another one). When a newer release exists it says so
and how to update: `git pull` in the checkout, then run the installer again with the same arguments. This
is the only network call the installer makes, and it runs only when you ask for it; neither a scan nor
`dowser.mjs` checks for updates.

## Software bill of materials

`npm run sbom` (`tools/sbom.mjs`) writes one CycloneDX JSON file per shipped lockfile for a release: the
skill (zero runtime dependencies, so its SBOM names the component alone), the Forge app backend and the
Forge inbox UI. It runs the `npm sbom` built into npm from the committed lockfiles, runtime dependencies
only, and refuses a lockfile with uncommitted changes. The files are named
`dowser-<skill|forge|forge-ui>-v<version>.cdx.json` and are attached to the release. When npm reports a
dependency tree problem (a peer range the installed version does not meet), the SBOM is still written and
the problem is listed in the tool's output.

## What Dowser handles

- The skill stores proposals and their quoted evidence lines in a local SQLite file under `~/.dowser/`
  (not encrypted at rest).
- When the Forge app is connected, the skill pushes each proposal with its evidence, including the quoted
  source and doc lines, to the Dowser inbox in Jira. To keep the lines on the machine, set
  `prefs set quotes=omit`: the push then carries each line's path, line number and a short hash
  (`quote_sha`) instead of its text. A quoted line the card repeats word for word in its title, rationale,
  body, confidence note or views is replaced by "the line at <path:line>". A part of a line, or code the card
  paraphrases, is sent as written.
- The Jira tickets, Confluence pages and goals a scan reads are cached on its run while it runs. When the
  run finishes their text is dropped from the store. An interrupted scan never finishes: its text is dropped
  by the first scan of the project that starts more than a day after it, so it can stay longer when no scan
  follows; their refs, titles and links stay, because cards cite
  them. The agent's work files (candidate lists, saved tool responses) go in the OS temp folder.
- The lens direction a team sets in the Forge app's Settings (per lens: focus and exclude lists, free-text
  notes and, for doc drift, the Confluence spaces to search) is pulled at the start of each scan and stored
  on that run in the same local file. Unlike ticket, page and goal text it is not dropped when the run
  ends: every run keeps the direction it scanned with, for as long as the local store exists. Delete
  `~/.dowser/projects/<project-key>/` to remove it.
- Dependency auditing runs `npm audit`, `osv-scanner` or `pip-audit` only when they are already installed.
  Dowser never installs them. They send the project's package names and versions to their advisory
  services (the npm registry, osv.dev, PyPI); `pip-audit` resolves a requirements file in a temporary
  environment of its own.
- In the Forge app an inbox follows Jira's permissions: it opens for whoever may browse the Jira project set
  for it in Dowser settings, for the account that first pushed to it until a project is set, and for Jira
  admins. This holds for the inbox, the issue panel, the Confluence byline, the Rovo agent and every MCP tool.
  Accept and merge create the issue or comment as the app, but only for a person who holds Create issues or
  Add comments there. A repo's project key is derived from its URL and is not a secret.
- The Forge app caps the length of every pushed card field and accepts evidence links only as `https://`
  URLs (a repo link may also be `http://`, for an `http://` git remote). The inbox renders a link only when
  it is `https://` or `http://`; any other scheme shows as plain text. Its per-call log lines name a project
  by a 12-hex hash of its key, never the key (which names the repo), and a failed call's line carries the
  error code, not its message.
