// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DiffLineStats } from "./DiffLineStats";

describe("DiffLineStats", () => {
  it("renders nothing when both values are null", () => {
    const { container } = render(
      <DiffLineStats insertions={null} deletions={null} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when both values are zero", () => {
    const { container } = render(
      <DiffLineStats insertions={0} deletions={0} />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders only insertions when deletions are null", () => {
    render(<DiffLineStats insertions={10} deletions={null} />);
    expect(screen.getByText("+10")).toBeInTheDocument();
    expect(screen.queryByText(/-/)).not.toBeInTheDocument();
  });

  it("renders only deletions when insertions are null", () => {
    render(<DiffLineStats insertions={null} deletions={5} />);
    expect(screen.getByText("-5")).toBeInTheDocument();
    expect(screen.queryByText(/\+/)).not.toBeInTheDocument();
  });

  it("renders both insertions and deletions", () => {
    render(<DiffLineStats insertions={10} deletions={5} />);
    expect(screen.getByText("+10")).toBeInTheDocument();
    expect(screen.getByText("-5")).toBeInTheDocument();
  });

  it("formats large numbers with en-US separators", () => {
    render(<DiffLineStats insertions={12345} deletions={6789} />);
    expect(screen.getByText("+12,345")).toBeInTheDocument();
    expect(screen.getByText("-6,789")).toBeInTheDocument();
  });

  it("renders only deletions when insertions are zero", () => {
    render(<DiffLineStats insertions={0} deletions={5} />);
    expect(screen.getByText("-5")).toBeInTheDocument();
    expect(screen.queryByText(/\+/)).not.toBeInTheDocument();
  });
});
