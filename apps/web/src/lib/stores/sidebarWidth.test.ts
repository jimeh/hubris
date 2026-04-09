// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSidebarWidthStoreForTests,
  useSidebarWidthStore,
} from "./sidebarWidth";

const LS_SIDEBAR_WIDTH = "hubris-sidebar-width";

function getStore() {
  resetSidebarWidthStoreForTests();
  return useSidebarWidthStore;
}

describe("Sidebar width store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  it("loads default width when storage is empty", async () => {
    const store = await getStore();
    expect(store.getState().width).toBe(256);
  });

  it("loads and clamps persisted width", async () => {
    localStorage.setItem(LS_SIDEBAR_WIDTH, "100");
    let store = await getStore();
    expect(store.getState().width).toBe(192);

    localStorage.setItem(LS_SIDEBAR_WIDTH, "900");
    store = await getStore();
    expect(store.getState().width).toBe(640);
  });

  it("falls back to default width for invalid persisted value", async () => {
    localStorage.setItem(LS_SIDEBAR_WIDTH, "not-a-number");
    const store = await getStore();
    expect(store.getState().width).toBe(256);
  });

  it("swallows localStorage errors during initial load", async () => {
    const getItemSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("localStorage read denied");
      });

    const store = await getStore();

    expect(store.getState().width).toBe(256);
    expect(getItemSpy).toHaveBeenCalled();
  });

  it("setWidth clamps min/max bounds", async () => {
    const store = await getStore();

    store.getState().setWidth(10);
    expect(store.getState().width).toBe(192);

    store.getState().setWidth(10_000);
    expect(store.getState().width).toBe(640);
  });

  it("debounces persistence to a single write for burst updates", async () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const store = await getStore();
    setItemSpy.mockClear();

    store.getState().setWidth(300);
    store.getState().setWidth(320);
    store.getState().setWidth(340);

    vi.advanceTimersByTime(149);
    expect(setItemSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith(LS_SIDEBAR_WIDTH, "340");
  });

  it("flushPendingPersist writes immediately and cancels timer", async () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const store = await getStore();
    setItemSpy.mockClear();

    store.getState().setWidth(333);
    expect(setItemSpy).not.toHaveBeenCalled();

    store.getState().flushPendingPersist();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
    expect(setItemSpy).toHaveBeenCalledWith(LS_SIDEBAR_WIDTH, "333");

    vi.runAllTimers();
    expect(setItemSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows localStorage errors during debounced persist", async () => {
    vi.useFakeTimers();
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("localStorage write denied");
      });

    const store = await getStore();

    expect(() => {
      store.getState().setWidth(300);
      vi.runAllTimers();
    }).not.toThrow();

    expect(store.getState().width).toBe(300);
    expect(setItemSpy).toHaveBeenCalled();
  });
});
