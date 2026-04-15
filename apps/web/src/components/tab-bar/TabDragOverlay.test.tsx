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
    selector: (state: { settings: { tabLabelMode: "process" } }) => unknown,
  ) => selector({ settings: { tabLabelMode: "process" } }),
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
      worktree_id: "w1",
      pane_id: "pane-1",
      session_id: "default",
      type: "terminal",
      created_at: 0,
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
  });
});
