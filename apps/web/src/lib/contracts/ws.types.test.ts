import { describe, expectTypeOf, it } from "vitest";

import type {
  ClientControlMessage,
  ServerControlMessage,
} from "./ws.generated";

describe("WS contract typing", () => {
  it("uses the generated control message unions", () => {
    expectTypeOf<ClientControlMessage>().toEqualTypeOf<{
      type: "resize";
      cols: number;
      rows: number;
      visible: boolean;
    }>();

    expectTypeOf<
      Extract<ServerControlMessage, { type: "attached" }>
    >().toEqualTypeOf<{
      type: "attached";
      byteOffset: number;
      snapshot: boolean;
      dataLost: boolean;
      cols: number;
      rows: number;
    }>();

    expectTypeOf<
      Extract<ServerControlMessage, { type: "pty_resized" }>
    >().toEqualTypeOf<{
      type: "pty_resized";
      cols: number;
      rows: number;
    }>();
  });
});
