// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppSidebarRoot from "./AppSidebarRoot";
import { SidebarProvider } from "@/components/ui/sidebar";
import { resetBootstrapForTests } from "@/lib/bootstrap";
import { executeCommand } from "@/lib/commands";
import { useWorktreeStore } from "@/lib/stores/worktrees";

vi.mock("@/lib/commands", () => ({
  executeCommand: vi.fn(),
}));

vi.mock("./SidebarDialogs", () => ({
  default: () => null,
}));

describe("AppSidebarRoot command entry points", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBootstrapForTests();
    vi.mocked(executeCommand).mockReset();
  });

  it("routes header actions through the shared command executor", () => {
    useWorktreeStore.setState({
      navigationBackIds: ["previous"],
      navigationForwardIds: ["next"],
    });

    render(
      <SidebarProvider defaultOpen>
        <AppSidebarRoot />
      </SidebarProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    fireEvent.click(screen.getByRole("button", { name: "Go forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(executeCommand).toHaveBeenNthCalledWith(1, {
      id: "worktree.navigateBack",
      source: "button",
    });
    expect(executeCommand).toHaveBeenNthCalledWith(2, {
      id: "worktree.navigateForward",
      source: "button",
    });
    expect(executeCommand).toHaveBeenNthCalledWith(3, {
      id: "project.add",
      source: "button",
    });
    expect(executeCommand).toHaveBeenNthCalledWith(4, {
      id: "app.openSettings",
      source: "button",
    });
  });
});
