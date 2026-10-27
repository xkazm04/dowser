---
name: dowser-proposals
description: Read Dowser's evidence-backed backlog proposals for this site - list open proposals by project, lens or status, and explain one with its full evidence trail. Use when a person asks what to build next, why a proposal exists, or what Dowser found for a goal or area.
---

# Dowser proposals

1. Call `dowser_inbox_list` (filter by `project_key`, `lens` or `status` when the person names one; the
   default is open proposals, newest scan first). Each item is compact: ref, title, rationale, lens,
   confidence, effort size, evidence count and types.
2. For any proposal the person asks about, call `dowser_proposal_explain` with its ref (`DW-12`).
3. Answer only from what the tools return, and cite the ref and the evidence (file and line, ticket key,
   page, goal). Never invent evidence. Unmeasured is not zero: when a field is missing, say it was not
   measured.
