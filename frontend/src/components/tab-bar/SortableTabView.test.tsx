// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SortableTabView from "./SortableTabView";

describe("SortableTabView", () => {
  it("renders a terminal icon", () => {
    render(
      <SortableTabView
        tabId="t1"
        label="Terminal 1"
        isActive={false}
        iconKind="terminal"
      />,
    );

    expect(screen.getByTestId("tab-terminal-icon")).toBeInTheDocument();
  });

  it("renders a material icon, tone class, preview styling, and title", () => {
    render(
      <SortableTabView
        tabId="d1"
        label="[staged] lib.rs M"
        title="[staged] src/lib.rs M"
        isActive={false}
        preview
        iconKind="material"
        iconPath="/icons/rust.svg"
        iconId="rust"
        toneClass="text-amber-500"
      />,
    );

    const icon = screen.getByTestId("tab-file-icon");
    expect(icon).toHaveAttribute("data-icon-id", "rust");

    const label = screen.getByText("[staged] lib.rs M");
    expect(label).toHaveClass("italic");
    expect(label).toHaveClass("text-amber-500");
    expect(screen.getByRole("tab")).toHaveAttribute(
      "title",
      "[staged] src/lib.rs M",
    );
  });
});
