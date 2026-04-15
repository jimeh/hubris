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
        label="lib.rs"
        labelSuffix="(Index)"
        statusLabel="M"
        title="src/lib.rs (Index) M"
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

    const label = screen.getByText("lib.rs");
    expect(label).toHaveClass("italic");
    expect(label.parentElement).toHaveClass("text-amber-500");
    expect(screen.getByText("(Index)")).toBeInTheDocument();
    expect(screen.getByTestId("tab-status-label")).toHaveTextContent("M");
    expect(screen.getByTestId("tab-status-label")).toHaveClass("text-[0.7em]");
    expect(screen.getByTestId("tab-status-label")).toHaveClass("font-semibold");
    expect(screen.getByRole("tab")).toHaveAttribute(
      "title",
      "src/lib.rs (Index) M",
    );
  });

  it("renders a lock icon immediately before close when locked", () => {
    render(
      <SortableTabView
        tabId="d1"
        label="lib.rs"
        isActive={false}
        locked
        onCloseTab={() => {}}
      />,
    );

    const lockIcon = screen.getByTestId("tab-lock-icon");
    const closeButton = screen.getByRole("button", { name: "Close lib.rs" });
    const srOnly = screen.getByText("read-only");
    expect(lockIcon.nextElementSibling).toBe(srOnly);
    expect(srOnly.nextElementSibling).toBe(closeButton);
  });

  it("caps tab width so long labels truncate instead of expanding forever", () => {
    render(
      <SortableTabView
        tabId="t1"
        label="very long process title that should not make the tab infinitely wide"
        isActive={false}
        iconKind="terminal"
      />,
    );

    expect(screen.getByRole("tab")).toHaveClass("min-w-0");
    expect(screen.getByRole("tab")).toHaveClass("max-w-72");
    expect(screen.getByRole("tab")).toHaveClass("overflow-hidden");
    expect(
      screen.getByText(
        "very long process title that should not make the tab infinitely wide",
      ),
    ).toHaveClass("truncate");
  });

  it("renders overlay tabs with the close button and active border styling", () => {
    render(
      <SortableTabView
        tabId="t1"
        label="Terminal 1"
        title="Terminal 1"
        isActive
        isOverlay
        showCloseButton
        onCloseTab={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Close Terminal 1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab")).toHaveClass("bg-tab-active");
    expect(screen.getByRole("tab")).toHaveClass(
      "shadow-[inset_0_-2px_0_var(--tab-active-border)]",
    );
    expect(screen.getByRole("tab")).not.toHaveClass("opacity-50");
  });
});
