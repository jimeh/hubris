import { describe, expectTypeOf, it } from "vitest";

import { EventClient } from "./events";

describe("EventClient typing", () => {
  it("infers payload shape from event name", () => {
    const client = new EventClient();

    client.on("tab_created", (payload) => {
      expectTypeOf(payload.session_id).toEqualTypeOf<string>();
      expectTypeOf(payload.tab.id).toEqualTypeOf<string>();
      expectTypeOf(payload.tab.label).toEqualTypeOf<string>();
    });

    client.on("project_removed", (payload) => {
      expectTypeOf(payload.project_id).toEqualTypeOf<string>();
    });

    client.on("vscode_updated", (payload) => {
      expectTypeOf(payload.selectedRuntime).toEqualTypeOf<
        "codeServer" | "vscodeCli"
      >();
      expectTypeOf(payload.codeServer.activeTaskId).toEqualTypeOf<
        string | null
      >();
      expectTypeOf(payload.vscodeCli.processStatus).toEqualTypeOf<
        "error" | "running" | "starting" | "stopped" | "stopping" | "installing"
      >();
      expectTypeOf(payload.codeServer.installProgress).toEqualTypeOf<{
        phase:
          | "preparing"
          | "downloading"
          | "extracting"
          | "cleaning"
          | "starting";
        percent: number;
        downloadedBytes: bigint | null;
        totalBytes: bigint | null;
      } | null>();
    });

    client.on("managed_process_updated", (payload) => {
      expectTypeOf(payload.id).toEqualTypeOf<string>();
      expectTypeOf(payload.kind).toEqualTypeOf<string>();
      expectTypeOf(payload.lifecycleState).toEqualTypeOf<
        "stopped" | "starting" | "running" | "stopping" | "exited" | "error"
      >();
      expectTypeOf(payload.pid).toEqualTypeOf<number | null>();
      expectTypeOf(payload.lastError).toEqualTypeOf<string | null>();
    });

    client.on("task_updated", (payload) => {
      type TaskStepState = (typeof payload.task.steps)[number]["state"];

      expectTypeOf(payload.task.definitionName).toEqualTypeOf<string>();
      expectTypeOf(payload.task.progressPercent).toEqualTypeOf<number>();
      expectTypeOf<TaskStepState>().toEqualTypeOf<
        | "pending"
        | "running"
        | "skipped"
        | "succeeded"
        | "failed"
        | "rollingBack"
        | "rolledBack"
        | "rollbackFailed"
      >();
    });
  });

  it("rejects invalid event and payload usage", () => {
    const client = new EventClient();

    // @ts-expect-error invalid event name
    client.on("not_real_event", () => {});

    client.on("tab_closed", (payload) => {
      // @ts-expect-error tab_closed payload does not include id
      expectTypeOf(payload.id).toEqualTypeOf<string>();
    });
  });
});
