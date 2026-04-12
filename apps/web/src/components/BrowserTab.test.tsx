import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBrowserState } from "@/lib/desktopBrowser";

const mockUpdateTab = vi.fn();
let desktopMode = false;
const mockDesktopCreate = vi.fn();
const mockDesktopSubscribe = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    updateTab: (...args: unknown[]) => mockUpdateTab(...args),
  };
});

vi.mock("@/lib/desktopBrowser", () => ({
  desktopBrowserBridge: () =>
    desktopMode
      ? {
          create: mockDesktopCreate,
          destroy: vi.fn(),
          show: vi.fn(),
          hide: vi.fn(),
          setBounds: vi.fn(),
          navigate: vi.fn(),
          goBack: vi.fn(),
          goForward: vi.fn(),
          reload: vi.fn(),
          subscribe: mockDesktopSubscribe,
        }
      : null,
  hasDesktopBrowserBridge: () => desktopMode,
}));

import BrowserTab from "@/components/BrowserTab";
import {
  resetBrowserTabStoreForTests,
  useBrowserTabStore,
} from "@/lib/stores/browserTabs";
import { resetTabStoreForTests, useTabStore } from "@/lib/stores/tabs";
import type { BrowserTab as BrowserTabInfo } from "@/lib/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
    desktopMode = false;
    mockDesktopCreate.mockReset();
    mockDesktopSubscribe.mockReset();
    mockDesktopSubscribe.mockReturnValue(() => {});
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
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "url");
    expect(input).toHaveAttribute("enterkeyhint", "go");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("autocapitalize", "none");
    expect(input).toHaveAttribute("name", "browser-url");
    expect(input).toHaveAttribute("data-1p-ignore", "true");
    expect(input).toHaveAttribute("data-lpignore", "true");
    expect(input.closest("form")).toHaveAttribute("novalidate");
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
          mode: "cors",
          redirect: "follow",
          cache: "no-store",
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://example.com/docs",
        expect.objectContaining({
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://example.com/docs",
        expect.objectContaining({
          method: "GET",
          mode: "cors",
          redirect: "follow",
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

  it("routes bare host input through custom normalization", async () => {
    const tab = makeBrowserTab();
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });

    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
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
    fireEvent.change(input, { target: { value: "github.com" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://github.com/",
        expect.objectContaining({
          method: "GET",
          mode: "cors",
          redirect: "follow",
          cache: "no-store",
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://github.com/",
        expect.objectContaining({
          method: "GET",
          mode: "no-cors",
          cache: "no-store",
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        "https://github.com/",
        expect.objectContaining({
          method: "GET",
          mode: "cors",
          redirect: "follow",
          cache: "no-store",
        }),
      );
    });

    await waitFor(() => {
      expect(useTabStore.getState().tabs[0]).toMatchObject({
        url: "https://github.com/",
        history: ["about:blank", "https://github.com/"],
        history_index: 1,
      });
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the redirected https target when an http probe upgrades", async () => {
    const tab = makeBrowserTab();
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });

    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockResolvedValueOnce({ url: "https://jimeh.me/" } as Response);
    mockUpdateTab.mockImplementation(async (_id, updates) => ({
      ...tab,
      label: updates.label,
      url: updates.url,
      history: updates.history,
      history_index: updates.history_index,
    }));

    render(<BrowserTab tab={tab} visible />);

    const input = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(input, { target: { value: "jimeh.me" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://jimeh.me/",
        expect.objectContaining({
          method: "GET",
          mode: "cors",
          redirect: "follow",
          cache: "no-store",
        }),
      );
    });

    await waitFor(() => {
      expect(useTabStore.getState().tabs[0]).toMatchObject({
        url: "https://jimeh.me/",
        history: ["about:blank", "https://jimeh.me/"],
        history_index: 1,
      });
    });
  });

  it("uses the latest stored browser history after async navigation resolves", async () => {
    const tab = makeBrowserTab();
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });

    const fetchRequest = deferred<Response>();
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockReturnValue(fetchRequest.promise);
    mockUpdateTab.mockImplementation(async (_id, updates) => ({
      ...useTabStore.getState().tabs[0],
      label: updates.label,
      url: updates.url,
      history: updates.history,
      history_index: updates.history_index,
    }));

    render(<BrowserTab tab={tab} visible />);

    const input = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(input, { target: { value: "jimeh.me" } });
    fireEvent.submit(input.closest("form")!);

    useTabStore.setState({
      tabs: [
        makeBrowserTab({
          ...tab,
          url: "https://mid.example/",
          history: ["about:blank", "https://mid.example/"],
          history_index: 1,
        }),
      ],
    });

    fetchRequest.resolve({ url: "https://jimeh.me/" } as Response);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "http://jimeh.me/",
        expect.objectContaining({
          method: "GET",
          mode: "cors",
          redirect: "follow",
          cache: "no-store",
        }),
      );
    });

    await waitFor(() => {
      expect(useTabStore.getState().tabs[0]).toMatchObject({
        url: "https://jimeh.me/",
        history: ["about:blank", "https://mid.example/", "https://jimeh.me/"],
        history_index: 2,
      });
    });
  });

  it("shows a custom inline error for invalid input", async () => {
    const tab = makeBrowserTab();
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });

    render(<BrowserTab tab={tab} visible />);

    const input = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(input, { target: { value: "not a url" } });
    fireEvent.submit(input.closest("form")!);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Can't open that page");
    expect(alert).toHaveTextContent(
      "Only http:// and https:// URLs are supported.",
    );
    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "Browser address" }),
      ).toHaveAttribute("aria-invalid", "true");
      expect(
        screen.getByRole("textbox", { name: "Browser address" }),
      ).toHaveAttribute("aria-describedby", `${tab.id}-browser-error`);
    });
  });

  it("clears the custom error after a successful navigation", async () => {
    const tab = makeBrowserTab();
    useTabStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeTabByWorktree: { [tab.worktree_id]: tab.id },
    });
    mockUpdateTab.mockImplementation(async (_id, updates) => ({
      ...tab,
      label: updates.label,
      url: updates.url,
      history: updates.history,
      history_index: updates.history_index,
    }));

    render(<BrowserTab tab={tab} visible />);

    const input = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(input, { target: { value: "not a url" } });
    fireEvent.submit(input.closest("form")!);

    await screen.findByRole("alert");

    fireEvent.change(input, { target: { value: "https://github.com/" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(
        screen.getByRole("textbox", { name: "Browser address" }),
      ).not.toHaveAttribute("aria-invalid");
      expect(
        screen.getByRole("textbox", { name: "Browser address" }),
      ).not.toHaveAttribute("aria-describedby");
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

  it("does not recreate the desktop browser view when the url changes", async () => {
    desktopMode = true;
    const tab = makeBrowserTab({
      id: "browser-desktop",
      label: "Docs",
      url: "http://localhost:3000/",
      history: ["http://localhost:3000/"],
    });
    const initialState: DesktopBrowserState = {
      tabId: tab.id,
      url: tab.url,
      title: "Docs",
      history: tab.history,
      historyIndex: tab.history_index,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      error: null,
    };
    mockDesktopCreate.mockResolvedValue({ state: initialState });

    const { rerender } = render(<BrowserTab tab={tab} visible />);

    await waitFor(() => {
      expect(mockDesktopCreate).toHaveBeenCalledTimes(1);
      expect(mockDesktopCreate).toHaveBeenCalledWith({
        tabId: tab.id,
        url: tab.url,
      });
    });

    const navigatedTab = {
      ...tab,
      url: "http://localhost:3000/docs",
      history: ["http://localhost:3000/", "http://localhost:3000/docs"],
      history_index: 1,
    };
    rerender(<BrowserTab tab={navigatedTab} visible />);

    await waitFor(() => {
      expect(mockDesktopCreate).toHaveBeenCalledTimes(1);
    });
  });
});
