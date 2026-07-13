// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";
import type { Worktree } from "@/lib/types";
import VscodeWorkbenchPane from "./VscodeWorkbenchPane";

const mockCreate = vi.fn();
const mockLoad = vi.fn();
const mockDestroy = vi.fn();
const mockShow = vi.fn();
const mockHide = vi.fn();
const mockSetBounds = vi.fn();
let desktopMode = false;

vi.mock("@/lib/desktopVscode", () => ({
  desktopVscodeBridge: () =>
    desktopMode
      ? {
          create: mockCreate,
          load: mockLoad,
          destroy: mockDestroy,
          show: mockShow,
          hide: mockHide,
          setBounds: mockSetBounds,
        }
      : null,
  hasDesktopVscodeBridge: () => desktopMode,
}));

function makeWorktree(): Worktree {
  return {
    id: "w-feature",
    projectId: "p1",
    name: "feature-a",
    path: "/tmp/feature-a",
    branch: "feature-a",
    sourceRef: null,
    uiMode: "vscode",
    isLocal: false,
    missingOnDisk: false,
    position: 2,
  };
}

describe("VscodeWorkbenchPane", () => {
  beforeEach(() => {
    resetSettingsStoreForTests();
    desktopMode = false;
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(undefined);
    mockLoad.mockReset();
    mockDestroy.mockReset();
    mockShow.mockReset();
    mockHide.mockReset();
    mockSetBounds.mockReset();
  });

  it("renders the expected iframe URL", () => {
    render(<VscodeWorkbenchPane worktree={makeWorktree()} active />);

    expect(
      screen.getByTitle("VS Code workbench for feature-a"),
    ).toHaveAttribute("src", "/code/vscode-cli/?folder=%2Ftmp%2Ffeature-a");
  });

  it("switches to the selected runtime URL", () => {
    useSettingsStore.getState().updateVscode({ runtime: "codeServer" });

    render(<VscodeWorkbenchPane worktree={makeWorktree()} active />);

    expect(
      screen.getByTitle("VS Code workbench for feature-a"),
    ).toHaveAttribute("src", "/code/code-server/?folder=%2Ftmp%2Ffeature-a");
  });

  it("keeps inactive panes mounted but hidden", () => {
    const { container } = render(
      <VscodeWorkbenchPane worktree={makeWorktree()} active={false} />,
    );

    const pane = container.querySelector("[data-vscode-workbench-pane]");

    expect(pane).toHaveAttribute("data-state", "inactive");
    expect(pane).toHaveAttribute("aria-hidden", "true");
    expect(
      screen.getByTitle("VS Code workbench for feature-a"),
    ).toBeInTheDocument();
  });

  it("uses the desktop bridge instead of rendering an iframe in desktop mode", () => {
    desktopMode = true;

    const { container } = render(
      <VscodeWorkbenchPane worktree={makeWorktree()} active />,
    );

    expect(mockCreate).toHaveBeenCalledWith({
      worktreeId: "w-feature",
      runtime: "vscodeCli",
      worktreePath: "/tmp/feature-a",
    });
    expect(mockShow).toHaveBeenCalledWith({ worktreeId: "w-feature" });
    expect(container.querySelector("iframe")).toBeNull();
    expect(
      container.querySelector("[title='VS Code workbench for feature-a']"),
    ).toBeInTheDocument();
  });

  it("loads the retained view when the selected runtime changes in desktop mode", () => {
    desktopMode = true;

    const { rerender } = render(
      <VscodeWorkbenchPane worktree={makeWorktree()} active />,
    );

    useSettingsStore.getState().updateVscode({ runtime: "codeServer" });
    rerender(<VscodeWorkbenchPane worktree={makeWorktree()} active />);

    expect(mockLoad).toHaveBeenCalledWith({
      worktreeId: "w-feature",
      runtime: "codeServer",
      worktreePath: "/tmp/feature-a",
    });
  });

  it("destroys the desktop view when the pane unmounts", () => {
    desktopMode = true;

    const { unmount } = render(
      <VscodeWorkbenchPane worktree={makeWorktree()} active />,
    );
    unmount();

    expect(mockDestroy).toHaveBeenCalledWith({ worktreeId: "w-feature" });
  });
});
