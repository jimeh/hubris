// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalTab } from "@/lib/types";
import TabDragOverlay from "./TabDragOverlay";

vi.mock("@/lib/stores/theme", () => ({
  useThemeSettings: (selector: (state: { activeTheme: null }) => unknown) =>
    selector({ activeTheme: null }),
}));

vi.mock("@/lib/stores/terminal", () => ({
  useTerminalSettings: (
    selector: (state: {
      settings: {
        smartTabNaming: true;
        escapeSequenceTitles: true;
      };
    }) => unknown,
  ) =>
    selector({
      settings: {
        smartTabNaming: true,
        escapeSequenceTitles: true,
      },
    }),
}));

vi.mock("@/lib/stores/worktreeFileManager", () => ({
  useWorktreeFileManagerStore: (
    selector: (state: {
      worktrees: Record<string, { gitStatus: null }>;
    }) => unknown,
  ) => selector({ worktrees: { w1: { gitStatus: null } } }),
}));

vi.mock("@/lib/tabPresentation", () => ({
  presentTab: () => ({
    label: "Terminal 1",
    title: "Terminal 1",
    iconKind: "terminal" as const,
  }),
}));

describe("TabDragOverlay", () => {
  it("mirrors inactive unfocused styling from the dragged tab", () => {
    const tab: TerminalTab = {
      id: "t1",
      label: "Terminal 1",
      position: 1,
      worktreeId: "w1",
      paneId: "pane-1",
      sessionId: "default",
      type: "terminal",
      createdAt: 0,
      preview: false,
    };

    render(
      <TabDragOverlay
        worktreeId="w1"
        tab={tab}
        width={240}
        isActive={false}
        paneFocused={false}
      />,
    );

    const overlayTab = screen.getByRole("tab");
    expect(overlayTab).toHaveClass("text-tab-inactive-foreground");
    expect(overlayTab).not.toHaveClass("bg-tab-active");
    expect(overlayTab).not.toHaveClass(
      "shadow-[inset_0_-2px_0_var(--tab-active-border)]",
    );
    expect(overlayTab).toHaveClass("bg-tab-bar");
    expect(overlayTab).toHaveClass("opacity-80");
  });

  it("mirrors muted active styling for unfocused active tabs", () => {
    const tab: TerminalTab = {
      id: "t1",
      label: "Terminal 1",
      position: 1,
      worktreeId: "w1",
      paneId: "pane-1",
      sessionId: "default",
      type: "terminal",
      createdAt: 0,
      preview: false,
    };

    render(
      <TabDragOverlay
        worktreeId="w1"
        tab={tab}
        width={240}
        isActive
        paneFocused={false}
      />,
    );

    const overlayTab = screen.getByRole("tab");
    expect(overlayTab).toHaveClass("text-tab-inactive-foreground");
    expect(overlayTab).toHaveClass(
      "shadow-[inset_0_-2px_0_color-mix(in_srgb,_var(--tab-active-border)_55%,_transparent)]",
    );
    expect(overlayTab).not.toHaveClass("bg-tab-active");
    expect(overlayTab).not.toHaveClass("bg-tab-bar");
    expect(overlayTab).toHaveClass("opacity-75");
  });

  it("renders active overlays with reduced opacity", () => {
    const tab: TerminalTab = {
      id: "t1",
      label: "Terminal 1",
      position: 1,
      worktreeId: "w1",
      paneId: "pane-1",
      sessionId: "default",
      type: "terminal",
      createdAt: 0,
      preview: false,
    };

    render(
      <TabDragOverlay
        worktreeId="w1"
        tab={tab}
        width={240}
        isActive
        paneFocused={true}
      />,
    );

    const overlayTab = screen.getByRole("tab");
    expect(overlayTab).toHaveClass("bg-tab-active");
    expect(overlayTab).toHaveClass("opacity-75");
  });
});
