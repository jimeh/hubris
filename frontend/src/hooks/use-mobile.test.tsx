import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./use-mobile";

function TestComponent() {
  const isMobile = useIsMobile();
  return <span>{isMobile ? "mobile" : "desktop"}</span>;
}

describe("useIsMobile", () => {
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
    let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
    window.innerWidth = 1280;

    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: false,
        media: "(max-width: 767px)",
        onchange: null,
        addEventListener: vi.fn(
          (_event: string, listener: (event: MediaQueryListEvent) => void) => {
            changeListener = listener;
          },
        ),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    );

    render(<TestComponent />);
    expect(screen.getByText("desktop")).toBeInTheDocument();

    act(() => {
      window.innerWidth = 640;
      changeListener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(screen.getByText("mobile")).toBeInTheDocument();
  });
});
