// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";

import {
  apiBase,
  codeBase,
  eventsUrl,
  resetDesktopRuntimeConfigForTests,
  terminalWsUrlBase,
} from "./desktopRuntime";

describe("desktopRuntime", () => {
  beforeEach(() => {
    resetDesktopRuntimeConfigForTests();
  });

  it("uses standalone defaults without desktop config", () => {
    expect(apiBase()).toBe("/api");
    expect(eventsUrl()).toBe("/api/events?session_id=default");
    expect(terminalWsUrlBase()).toBe("");
    expect(codeBase()).toBe("/code/");
  });

  it("uses injected desktop config when present", () => {
    window.__HUBRIS_DESKTOP_CONFIG__ = {
      apiBase: "https://desktop.internal.hubris.build/api",
      eventsUrl: "https://desktop.internal.hubris.build/api/events",
      terminalWsBase: "wss://desktop.internal.hubris.build/api/terminal/ws",
      codeBase: "https://desktop.internal.hubris.build/code/",
    };

    expect(apiBase()).toBe("https://desktop.internal.hubris.build/api");
    expect(eventsUrl("alt")).toBe(
      "https://desktop.internal.hubris.build/api/events?session_id=alt",
    );
    expect(terminalWsUrlBase()).toBe(
      "wss://desktop.internal.hubris.build/api/terminal/ws",
    );
    expect(codeBase()).toBe("https://desktop.internal.hubris.build/code/");
  });
});
