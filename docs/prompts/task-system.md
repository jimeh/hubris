# Task System

Hubris now has multiple VS Code runtime implementations to manage, including
official VS Code `code` CLI and Coder `code-server`. Both need backend work for
things like checking for updates, installing runtimes, upgrading them, and
reporting progress/status back to the UI.

I want a reusable backend task system for this kind of work, similar in spirit
to the process manager: a shared Rust abstraction for long-running, multi-step
operations with structured progress and failure handling.

## Goal

Create a generic task system in the Rust backend that can run multi-step tasks,
track progress and status, optionally emit live updates over SSE, and support
rollback on failure.

## Scope

- Focus on backend Rust/Axum code first.
- Design this as reusable infrastructure, not a VS Code-specific helper.
- Use VS Code runtime install/update flows as the first concrete consumer.

## Desired Outcome

- Hubris has a first-class task abstraction for multi-step backend operations.
- Hubris can expose both task definitions and task invocations over the API.
- A task can be composed from one or more ordered steps.
- Each step can run work, report progress/status, and optionally define rollback
  logic.
- If a task fails after partial success, rollback runs in reverse order for the
  steps that already completed.
- Tasks can optionally publish updates over the existing SSE event channel.
- VS Code runtime installation/update/check flows can be expressed in terms of
  this task system instead of bespoke progress plumbing.

## Core Requirements

- Distinguish between:
  - a task definition/type with a stable bespoke name
  - a task invocation/instance with its own unique runtime ID
- A task definition should be referencable by name when creating/executing a new
  task instance.
- A task invocation should have a stable unique ID and an inspectable state.
- A task should support multiple named steps.
- Each step should have:
  - a name
  - forward action/logic
  - optional rollback action/logic
- Tasks should support input arguments when starting a new invocation.
- A task should expose progress in a flexible way:
  - direct absolute progress updates
  - step-weighted progress, where a step represents a portion of total task
    progress and reports its own sub-progress
- A task should expose status text that can be updated from any step.
- Rollback should run in reverse order for successfully completed steps when a
  later step fails.
- Not every task needs SSE reporting. Broadcasting task updates should be
  optional.

## Integration Requirements

- Reuse Hubris’s current architecture patterns:
  - REST for actions/starts where appropriate
  - SSE for live shared state updates
- The REST API should support at least:
  - listing available task definitions that can be executed
  - listing current/recent task invocations that are running or otherwise
    inspectable
  - starting a new task invocation by task name plus input arguments
- The first migration target should be VS Code runtime work such as:
  - checking for updates
  - installing a runtime
  - upgrading/reinstalling a runtime
- The resulting UI-facing progress model should be generic enough that the
  frontend is not tightly coupled to only code-server-specific install phases.

## Relevant Existing Code

- `docs/prompts/process-manager.md`
- `apps/server/src/code_server.rs`
- `apps/server/src/api/code_server.rs`
- `apps/server/src/events.rs`
- `apps/web/src/lib/stores/codeServer.ts`
- `apps/web/src/components/settings-dialog/VscodeSettings.tsx`
- `docs/agents/architecture.md`

## Design Guidance

- Keep the abstraction practical. This does not need to become a heavyweight
  workflow engine.
- Prefer a narrow, understandable model that fits Hubris’s current needs.
- Shared task concepts should be generic; runtime-specific details should stay
  in the VS Code runtime implementations that use the task system.
- The system should make it easier to add other backend tasks later, not just
  the current VS Code work.

## Deliverables

- Reusable backend task abstraction and implementation
- REST API for task definitions and task invocations
- Optional SSE reporting for task updates
- VS Code runtime install/update/check flows migrated onto tasks
- Tests covering task progress, failure handling, rollback behavior, and live
  update integration

## Verification

- Verify task state and progress update correctly.
- Verify rollback order and failure semantics.
- Verify SSE-reported tasks produce sensible live updates for the frontend.
- Run the relevant tests you touch, then finish with:

```sh
mise run check
```
