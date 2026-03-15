import { describe, expectTypeOf, it } from "vitest";

import { EventClient } from "./events";

describe("EventClient typing", () => {
  it("infers payload shape from event name", () => {
    const client = new EventClient();

    client.on("tab_created", (payload) => {
      expectTypeOf(payload.id).toEqualTypeOf<string>();
      expectTypeOf(payload.label).toEqualTypeOf<string>();
    });

    client.on("project_removed", (payload) => {
      expectTypeOf(payload.project_id).toEqualTypeOf<string>();
    });

    client.on("settings_updated", (payload) => {
      expectTypeOf(payload.appearance.colorScheme).toEqualTypeOf<string>();
      expectTypeOf(payload.terminal.fontSize).toEqualTypeOf<number>();
    });

    client.on("snapshot", (payload) => {
      expectTypeOf(
        payload.settings.worktree.locationMode,
      ).toEqualTypeOf<string>();
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
