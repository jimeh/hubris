import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./use-mobile";

function TestComponent() {
  const isMobile = useIsMobile();
  return <span>{isMobile ? "mobile" : "desktop"}</span>;
}

const originalInnerWidth = window.innerWidth;
const originalMatchMedia = window.matchMedia;

describe("useIsMobile", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.innerWidth = originalInnerWidth;
    window.matchMedia = originalMatchMedia;
    vi.unstubAllGlobals();
  });

  it("uses the current media query match on first render", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    window.innerWidth = 640;

    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        media: "(max-width: 767px)",
        onchange: null,
        addEventListener,
        removeEventListener,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );

    render(<TestComponent />);

    expect(screen.getByText("mobile")).toBeInTheDocument();
    expect(addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });

  it("updates when the media query listener fires", () => {
    let matches = false;
    let changeListener: (() => void) | undefined;
    window.innerWidth = 1280;

    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation(() => ({
        matches,
        media: "(max-width: 767px)",
        onchange: null,
        addEventListener: vi.fn((_event: string, listener: () => void) => {
          changeListener = listener;
        }),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );

    render(<TestComponent />);
    expect(screen.getByText("desktop")).toBeInTheDocument();

    act(() => {
      matches = true;
      window.innerWidth = 640;
      changeListener?.();
    });

    expect(screen.getByText("mobile")).toBeInTheDocument();
  });
});
