// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/lib/types";
import type { DialogState } from "./types";
import SidebarDialogs from "./SidebarDialogs";

vi.mock("@/components/AddProjectDialog", () => ({
  default: () => null,
}));

vi.mock("@/components/AddWorktreeDialog", () => ({
  default: () => null,
}));

vi.mock("@/components/WorktreeRemoveDialog", () => ({
  default: () => null,
}));

vi.mock("@/components/RenameProjectDialog", () => ({
  default: () => null,
}));

vi.mock("@/components/SettingsDialog", () => ({
  default: () => null,
}));

function makeDialogState(overrides: Partial<DialogState> = {}): DialogState {
  return {
    addProject: false,
    showSettings: false,
    addWorktree: null,
    renameProject: null,
    confirmRemoveProject: null,
    confirmForceRemoveProject: null,
    confirmRemoveWorktree: null,
    renameWorktree: null,
    confirmForceRemoveWorktree: null,
    actionError: null,
    ...overrides,
  };
}

function makeProject(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    position: 1,
  };
}

function renderSidebarDialogs(dialogState: DialogState) {
  const onRemoveProject = vi.fn().mockResolvedValue(undefined);

  render(
    <SidebarDialogs
      dialogState={dialogState}
      projects={[makeProject("p1", "Devbox")]}
      setDialogState={vi.fn()}
      onAddProject={vi.fn()}
      onAddWorktree={vi.fn()}
      onImportWorktree={vi.fn()}
      onRenameProject={vi.fn()}
      onRenameWorktree={vi.fn()}
      onRemoveProject={onRemoveProject}
      onRemoveWorktree={vi.fn()}
    />,
  );

  return { onRemoveProject };
}

describe("SidebarDialogs", () => {
  it("offers remove-only and delete-managed actions for project removal", () => {
    const { onRemoveProject } = renderSidebarDialogs(
      makeDialogState({ confirmRemoveProject: "p1" }),
    );

    expect(
      screen.getByText(/leave all worktrees and directories on disk/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/git-linked worktrees outside hubris are left alone/i),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove only" }));

    expect(onRemoveProject).toHaveBeenCalledWith("p1", {
      deleteManagedWorktrees: false,
    });
  });

  it("calls delete-managed removal when the destructive action is chosen", () => {
    const { onRemoveProject } = renderSidebarDialogs(
      makeDialogState({ confirmRemoveProject: "p1" }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove + delete managed worktrees",
      }),
    );

    expect(onRemoveProject).toHaveBeenCalledWith("p1", {
      deleteManagedWorktrees: true,
    });
  });

  it("offers remove-only fallback and force-delete action for conflict follow-up", () => {
    const { onRemoveProject } = renderSidebarDialogs(
      makeDialogState({ confirmForceRemoveProject: "p1" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove only" }));

    expect(onRemoveProject).toHaveBeenCalledWith("p1", {
      deleteManagedWorktrees: false,
    });
  });

  it("force-conflict dialog can force managed deletion", () => {
    const { onRemoveProject } = renderSidebarDialogs(
      makeDialogState({ confirmForceRemoveProject: "p1" }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Force remove + delete managed worktrees",
      }),
    );

    expect(onRemoveProject).toHaveBeenCalledWith("p1", {
      deleteManagedWorktrees: true,
      force: true,
    });
  });
});
