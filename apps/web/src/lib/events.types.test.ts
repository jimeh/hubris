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
