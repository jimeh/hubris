# Process Manager

Hubris currently has code-server-specific process lifecycle logic embedded in
`apps/server/src/code_server.rs`. I want that logic extracted into a reusable
backend component for managing external processes, then have the existing
code-server flow use that component.

## Goal

Create a reusable process management subsystem that can manage multiple named
external processes and expose their current state for inspection.

## Scope

- Focus on backend Rust/Axum code.
- Preserve current code-server behavior and API semantics unless there is a
  strong reason to change them.
- Reuse Hubris' existing architecture:
  - REST for actions
  - global SSE snapshot + incremental events for shared live state
- Keep the design practical. Do not build a full generic supervisor framework.

## Requirements

- Extract reusable process lifecycle logic from the current code-server manager.
- Support managing multiple processes by stable ID.
- Track enough metadata to inspect managed processes:
  - id
  - kind/name
  - lifecycle state
  - pid if available
  - start time
  - exit status or last error
- Support lifecycle operations where appropriate:
  - start
  - stop
  - restart
  - inspect/list
- Preserve important existing process semantics from code-server:
  - serialize conflicting lifecycle transitions
  - graceful shutdown before forced kill
  - preserve Unix process-group shutdown behavior
  - preserve Linux parent-death behavior if relevant
  - normalize dead child processes into visible state

## Migration Constraints

- Refactor code-server to use the new process manager.
- Keep current code-server REST behavior working unless a change is clearly
  justified.
- Do not change PTY terminal management in this task.
- Do not add polling-based frontend refresh logic.
- Do not redesign unrelated settings or frontend state flows.

## Deliverables

- Reusable backend process manager abstraction and implementation
- Refactored code-server integration
- Inspection/list API for managed processes if needed
- Event/state integration consistent with existing Hubris patterns
- Tests covering lifecycle, shutdown, dead-process handling, and integration

## Approach

First inspect the current code-server lifecycle and identify the minimal
reusable abstraction. Prefer a narrow design that fits Hubris' current needs
over a fully generic framework. Call out tradeoffs if there is a choice between
a simpler code-server-specific abstraction and a broader multi-process registry.
