// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ToastViewport from "./ToastViewport";
import { builtinThemes } from "@/lib/theme/builtin";
import {
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";

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

  it("uses the active settings theme and expected viewport placement", () => {
    resetSettingsStoreForTests();
    useSettingsStore.setState({
      activeTheme:
        builtinThemes.find((theme) => theme.id === "hubris-dark") ?? null,
      prefersLight: true,
    });

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
