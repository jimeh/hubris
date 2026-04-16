// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";

import {
  apiBase,
  eventsUrl,
  resetDesktopRuntimeConfigForTests,
  terminalWsUrlBase,
  vscodeBase,
} from "./desktopRuntime";

describe("desktopRuntime", () => {
  beforeEach(() => {
    resetDesktopRuntimeConfigForTests();
  });

  it("uses standalone defaults without desktop config", () => {
    expect(apiBase()).toBe("/api");
    expect(eventsUrl()).toBe("/api/events?session_id=default");
    expect(terminalWsUrlBase()).toBe("");
    expect(vscodeBase("vscodeCli")).toBe("/code/vscode-cli/");
    expect(vscodeBase("codeServer")).toBe("/code/code-server/");
  });

  it("uses injected desktop config when present", () => {
    window.__HUBRIS_DESKTOP_CONFIG__ = {
      apiBase: "https://desktop.internal.hubris.build/api",
      eventsUrl: "https://desktop.internal.hubris.build/api/events",
      terminalWsBase: "wss://desktop.internal.hubris.build/api/terminal/ws",
      vscodeBases: {
        codeServer: "https://code-server.desktop.internal.hubris.build/",
        vscodeCli: "https://vscode-cli.desktop.internal.hubris.build/",
      },
    };

    expect(apiBase()).toBe("https://desktop.internal.hubris.build/api");
    expect(eventsUrl("alt")).toBe(
      "https://desktop.internal.hubris.build/api/events?session_id=alt",
    );
    expect(terminalWsUrlBase()).toBe(
      "wss://desktop.internal.hubris.build/api/terminal/ws",
    );
    expect(vscodeBase("codeServer")).toBe(
      "https://code-server.desktop.internal.hubris.build/",
    );
    expect(vscodeBase("vscodeCli")).toBe(
      "https://vscode-cli.desktop.internal.hubris.build/",
    );
  });
});
