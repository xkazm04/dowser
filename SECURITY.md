# Security policy

## Reporting a vulnerability

Report security problems privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for a security problem.

Please include what is affected (the skill, its scripts, or the Dowser for Jira Forge app), the version or
commit, and the steps that show the problem. We acknowledge a report within 5 working days and tell you what
we will do about it.

## Supported versions

Dowser is pre-release (0.x). Only the latest commit on `master` receives security fixes. Support periods for
released versions will be stated here when the first release is tagged.

## What Dowser handles

- The skill stores proposals and their quoted evidence lines in a local SQLite file under `~/.dowser/`
  (not encrypted at rest).
- When the Forge app is connected, the skill pushes each proposal with its evidence, including the quoted
  source and doc lines, to the Dowser inbox in Jira. To keep the lines on the machine, set
  `prefs set quotes=omit`: the push then carries each line's path, line number and a short hash
  (`quote_sha`) instead of its text. The setting covers evidence only: a card's title, rationale and body
  are sent as written and can name code.
- The Jira tickets, Confluence pages and goals a scan reads are cached on its run while it runs. When the
  run finishes, their text is dropped from the store; their refs, titles and links stay, because cards cite
  them. The agent's work files (candidate lists, saved tool responses) go in the OS temp folder.
- Dependency auditing runs `npm audit`, `osv-scanner` or `pip-audit` only when they are already installed.
  Dowser never installs them. They send the project's package names and versions to their advisory
  services (the npm registry, osv.dev, PyPI); `pip-audit` resolves a requirements file in a temporary
  environment of its own.
