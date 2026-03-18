// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtinThemes } from "@/lib/theme/builtin";

const toasterSpy = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
  Toaster: (props: Record<string, unknown>) => {
    toasterSpy(props);
    return (
      <div
        data-testid="toast-viewport"
        data-position={String(props.position)}
        data-theme={String(props.theme)}
      />
    );
  },
}));

describe("ToastViewport", () => {
  beforeEach(() => {
    toasterSpy.mockReset();
  });

  it("uses the active settings theme and expected viewport placement", async () => {
    const store = await import("@/lib/stores/settings");
    store.resetSettingsStoreForTests();
    store.useSettingsStore.setState({
      activeTheme:
        builtinThemes.find((theme) => theme.id === "hubris-dark") ?? null,
      prefersLight: true,
    });

    const { default: ToastViewport } = await import("./ToastViewport");
    render(<ToastViewport />);

    expect(screen.getByTestId("toast-viewport")).toHaveAttribute(
      "data-position",
      "bottom-right",
    );
    expect(screen.getByTestId("toast-viewport")).toHaveAttribute(
      "data-theme",
      "dark",
    );
    expect(toasterSpy).toHaveBeenCalled();
  });
});
