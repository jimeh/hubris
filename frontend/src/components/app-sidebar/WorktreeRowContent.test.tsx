import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import WorktreeRowContent from "./WorktreeRowContent";

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
});
