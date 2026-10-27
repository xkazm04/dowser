# Dowser

Dowser finds what your product should do next. It joins user pain, code capability and
organizational intent into evidence-backed backlog proposals.

**Status: design.** The original plan (cloud scans on Forge, Codegeist 2026) is in
[docs/project-documentation.md](docs/project-documentation.md). The working deviation: scans run
**locally**, as a skill in an LLM CLI (Claude Code, Codex CLI) against a checked-out repo. The
skill carries the procedures and a per-project memory that learns from triage, and its scripts
connect to the core architecture.

Design runs live in `.spark/` (gitignored); the overlay is `.claude/spark/config.md`.
