// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";
import type { Worktree } from "@/lib/types";
import VscodeWorkbenchPane from "./VscodeWorkbenchPane";

function makeWorktree(): Worktree {
  return {
    id: "w-feature",
    project_id: "p1",
    name: "feature-a",
    path: "/tmp/feature-a",
    branch: "feature-a",
    source_ref: null,
    ui_mode: "vscode",
    is_local: false,
    missing_on_disk: false,
    position: 2,
  };
}

describe("VscodeWorkbenchPane", () => {
  beforeEach(() => {
    resetSettingsStoreForTests();
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
});
