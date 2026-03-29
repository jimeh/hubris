import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  it("does not apply the hover background class to selected rows", () => {
    render(<WorktreeRowContent isSelected contentSlot={<span>local</span>} />);

    const row = screen.getByText("local").closest("div");

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

    const row = screen.getByText("feature-a").closest("div");

    expect(row).toHaveClass("hover:bg-sidebar-accent");
  });

  it("labels the missing-worktree warning icon for assistive tech", () => {
    render(
      <TooltipProvider>
        <WorktreeRow
          worktree={{
            id: "missing",
            project_id: "project-1",
            path: "/tmp/missing",
            branch: "feature-a",
            source_ref: null,
            ui_mode: "hubris",
            name: "feature-a",
            position: 2,
            is_local: false,
            missing_on_disk: true,
          }}
          isSelected={false}
          isSorting={false}
          onSelect={() => {}}
          onRemove={() => {}}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("Worktree missing on disk")).toBeVisible();
  });
});
