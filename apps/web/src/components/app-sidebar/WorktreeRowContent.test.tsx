import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resetVscodeWorkbenchStoreForTests } from "@/lib/stores/vscodeWorkbench";
import WorktreeRowContent from "./WorktreeRowContent";
import WorktreeRow from "./WorktreeRow";

const sortableMock = {
  attributes: {},
  listeners: {},
  setNodeRef: () => {},
  transform: null,
  transition: undefined,
  isDragging: false,
};

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => sortableMock,
}));

describe("WorktreeRowContent", () => {
  it("renders a custom leading slot when provided", () => {
    resetVscodeWorkbenchStoreForTests();

    render(
      <WorktreeRowContent
        isSelected={false}
        leadingSlot={<span aria-label="custom leading" />}
        contentSlot={<span>feature-a</span>}
      />,
    );

    expect(screen.getByLabelText("custom leading")).toBeInTheDocument();
  });

  it("does not apply the hover background class to selected rows", () => {
    render(<WorktreeRowContent isSelected contentSlot={<span>local</span>} />);

    const row = screen.getByText("local").closest("div.group\\/worktree-row");

    expect(row).not.toHaveClass("hover:bg-sidebar-accent");
    expect(row).toHaveClass("bg-sidebar-primary");
  });

  it("keeps the hover background class for unselected rows", () => {
    render(
      <WorktreeRowContent
        isSelected={false}
        contentSlot={<span>feature-a</span>}
      />,
    );

    const row = screen
      .getByText("feature-a")
      .closest("div.group\\/worktree-row");

    expect(row).toHaveClass("hover:bg-sidebar-accent");
  });

  it("collapses the action area until hover or focus within", () => {
    render(
      <WorktreeRowContent
        isSelected={false}
        contentSlot={<span>feature-a</span>}
        actionSlot={<button type="button">Actions</button>}
      />,
    );

    const row = screen
      .getByText("feature-a")
      .closest("div.group\\/worktree-row");
    const actionContainer = screen.getByRole("button", {
      name: "Actions",
    }).parentElement;

    expect(row).not.toHaveClass("pr-8");
    expect(actionContainer).toHaveClass("max-w-0");
    expect(actionContainer).toHaveClass("overflow-hidden");
    expect(actionContainer).toHaveClass("pointer-events-none");
    expect(actionContainer).toHaveClass("opacity-0");
    expect(actionContainer).toHaveClass("group-hover/worktree-row:max-w-24");
    expect(actionContainer).toHaveClass("group-hover/worktree-row:opacity-100");
    expect(actionContainer).toHaveClass(
      "group-focus-within/worktree-row:max-w-24",
    );
    expect(actionContainer).toHaveClass(
      "group-focus-within/worktree-row:opacity-100",
    );
    expect(actionContainer).toHaveClass(
      "group-has-data-[state=open]/worktree-row:max-w-24",
    );
    expect(actionContainer).toHaveClass(
      "group-has-data-[state=open]/worktree-row:opacity-100",
    );
  });

  it("makes the shared content wrapper a flex item so child buttons can shrink", () => {
    render(
      <WorktreeRowContent
        isSelected={false}
        contentSlot={<button type="button">feature-a</button>}
      />,
    );

    const contentWrapper = screen.getByRole("button", {
      name: "feature-a",
    }).parentElement;

    expect(contentWrapper).toHaveClass("flex");
    expect(contentWrapper).toHaveClass("min-w-0");
    expect(contentWrapper).toHaveClass("flex-1");
  });

  it("gives worktree labels constrained flex width for ellipsis truncation", () => {
    render(
      <TooltipProvider>
        <WorktreeRow
          worktree={{
            id: "long-name",
            projectId: "project-1",
            path: "/tmp/long-name",
            branch: "feature/some-very-long-branch-name",
            sourceRef: null,
            uiMode: "hubris",
            name: "some-very-long-worktree-name",
            position: 2,
            isLocal: false,
            missingOnDisk: false,
          }}
          isSelected={false}
          isSorting={false}
          onSelect={() => {}}
          onRename={() => {}}
          onRemove={() => {}}
        />
      </TooltipProvider>,
    );

    const label = screen.getByText("some-very-long-worktree-name");
    const button = label.closest("button");

    expect(button).toHaveClass("min-w-0");
    expect(button).toHaveClass("flex-1");
    expect(label).toHaveClass("min-w-0");
    expect(label).toHaveClass("flex-1");
    expect(label).toHaveClass("truncate");
  });

  it("labels the missing-worktree warning icon for assistive tech", () => {
    render(
      <TooltipProvider>
        <WorktreeRow
          worktree={{
            id: "missing",
            projectId: "project-1",
            path: "/tmp/missing",
            branch: "feature-a",
            sourceRef: null,
            uiMode: "hubris",
            name: "feature-a",
            position: 2,
            isLocal: false,
            missingOnDisk: true,
          }}
          isSelected={false}
          isSorting={false}
          onSelect={() => {}}
          onRename={() => {}}
          onRemove={() => {}}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("Worktree missing on disk")).toBeVisible();
  });
});
