// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const LS_RIGHT_SIDEBAR_WIDTH = "hubris-worktree-right-sidebar-width";

async function getStore() {
  const mod = await import("./worktreeRightSidebarWidth");
  mod.resetWorktreeRightSidebarWidthStoreForTests();
  return mod.useWorktreeRightSidebarWidthStore;
}

describe("Worktree right sidebar width store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("loads default width when storage is empty", async () => {
    const store = await getStore();
    expect(store.getState().width).toBe(320);
  });

  it("loads and clamps persisted width", async () => {
    localStorage.setItem(LS_RIGHT_SIDEBAR_WIDTH, "100");
    let store = await getStore();
    expect(store.getState().width).toBe(240);

    vi.resetModules();
    localStorage.setItem(LS_RIGHT_SIDEBAR_WIDTH, "900");
    store = await getStore();
    expect(store.getState().width).toBe(640);
  });

  it("falls back to default width for invalid persisted value", async () => {
    localStorage.setItem(LS_RIGHT_SIDEBAR_WIDTH, "not-a-number");
    const store = await getStore();
    expect(store.getState().width).toBe(320);
  });

  it("setWidth clamps min/max bounds", async () => {
    const store = await getStore();

    store.getState().setWidth(10);
    expect(store.getState().width).toBe(240);

    store.getState().setWidth(10_000);
    expect(store.getState().width).toBe(640);
  });

  it("debounces persistence to a single write for burst updates", async () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const store = await getStore();
    setItemSpy.mockClear();

    store.getState().setWidth(360);
    store.getState().setWidth(400);
    store.getState().setWidth(440);

    vi.advanceTimersByTime(149);
    expect(setItemSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith(LS_RIGHT_SIDEBAR_WIDTH, "440");
  });

  it("flushPendingPersist writes immediately and cancels timer", async () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const store = await getStore();
    setItemSpy.mockClear();

    store.getState().setWidth(444);
    expect(setItemSpy).not.toHaveBeenCalled();

    store.getState().flushPendingPersist();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith(LS_RIGHT_SIDEBAR_WIDTH, "444");

    vi.runAllTimers();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows localStorage errors during reads and writes", async () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("localStorage read denied");
      });

    const store = await getStore();

    expect(store.getState().width).toBe(320);
    expect(getItemSpy).toHaveBeenCalled();

    vi.useFakeTimers();
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("localStorage write denied");
      });

    expect(() => {
      store.getState().setWidth(360);
      vi.runAllTimers();
    }).not.toThrow();

    expect(store.getState().width).toBe(360);
    expect(setItemSpy).toHaveBeenCalled();
  });
});
