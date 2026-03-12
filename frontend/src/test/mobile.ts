import { vi } from "vitest";

export function setMobile(matches: boolean): void {
  window.innerWidth = matches ? 640 : 1280;
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 767px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}
