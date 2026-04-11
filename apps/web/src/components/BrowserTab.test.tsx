import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdateTab = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    updateTab: (...args: unknown[]) => mockUpdateTab(...args),
  };
});

vi.mock("@/lib/desktopBrowser", () => ({
  desktopBrowserBridge: () => null,
  hasDesktopBrowserBridge: () => false,
}));

import BrowserTab from "@/components/BrowserTab";
import {
  resetBrowserTabStoreForTests,
  useBrowserTabStore,
} from "@/lib/stores/browserTabs";
import { resetTabStoreForTests, useTabStore } from "@/lib/stores/tabs";
import type { BrowserTab as BrowserTabInfo } from "@/lib/types";

function makeBrowserTab(
  overrides: Partial<BrowserTabInfo> = {},
): BrowserTabInfo {
  return {
    id: overrides.id ?? "browser-1",
    label: overrides.label ?? "New Browser",
    position: overrides.position ?? 1,
    worktree_id: overrides.worktree_id ?? "w1",
    session_id: overrides.session_id ?? "default",
    type: "browser",
    created_at: overrides.created_at ?? 0,
    preview: overrides.preview ?? false,
    url: overrides.url ?? "about:blank",
    history: overrides.history ?? ["about:blank"],
    history_index: overrides.history_index ?? 0,
  };
}

describe("BrowserTab", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUpdateTab.mockReset();
    resetBrowserTabStoreForTests();
    resetTabStoreForTests();
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = vi.fn();
  });

  it("focuses the blank browser tab address bar and disables password managers", async () => {
    const tab = makeBrowserTab();
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });

    render(<BrowserTab tab={tab} visible />);

    const input = screen.getByRole("textbox", { name: "Browser address" });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("type", "url");
    expect(input).toHaveAttribute("inputmode", "url");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("name", "browser-url");
    expect(input).toHaveAttribute("data-1p-ignore", "true");
    expect(input).toHaveAttribute("data-lpignore", "true");
  });

  it("retries https after an http transport failure for scheme-less input", async () => {
    const tab = makeBrowserTab();
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });

    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    mockUpdateTab.mockImplementation(async (_id, updates) => ({
      ...tab,
      label: updates.label,
      url: updates.url,
      history: updates.history,
      history_index: updates.history_index,
    }));

    render(<BrowserTab tab={tab} visible />);

    const input = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(input, { target: { value: "example.com/docs" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://example.com/docs",
        expect.objectContaining({
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://example.com/docs",
        expect.objectContaining({
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
        }),
      );
    });

    await waitFor(() => {
      expect(useTabStore.getState().tabs[0]).toMatchObject({
        url: "https://example.com/docs",
        history: ["about:blank", "https://example.com/docs"],
        history_index: 1,
      });
    });
  });

  it("loads localhost previews directly in the iframe", () => {
    const tab = makeBrowserTab({
      label: "localhost",
      url: "http://localhost:3000/docs",
      history: ["http://localhost:3000/docs"],
    });
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });
    useBrowserTabStore.getState().ensureSession(tab.id, tab.url, false, false);

    render(<BrowserTab tab={tab} visible />);

    expect(screen.getByTitle("localhost")).toHaveAttribute(
      "src",
      "http://localhost:3000/docs",
    );
  });
});
