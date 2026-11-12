# Local Markdown tickets

Tickets live in `.scratch/<feature>/issues/NN-<slug>.md`, with one file per ticket. The feature's `spec.md` records its implementation decisions.

Each ticket contains a description, `Blocked by:`, `Status:`, and acceptance criteria. Use `open`, `in-progress`, `blocked`, or `done` for status. Dependencies are satisfied when their status is `done`.

1. Read the ticket, its dependencies, and referenced requirements or ADRs.
2. Set the status to `in-progress` before implementing.
3. Verify the acceptance criteria with the relevant checks and update the checklist.
4. Record useful results or blockers under `## Comments`, then update the final status.

Create new tickets using the next available number in the feature's `issues/` directory. Look up existing tickets by path or number. Record lasting design decisions in the spec or an ADR.
