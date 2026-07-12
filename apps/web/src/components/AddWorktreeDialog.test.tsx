import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import AddWorktreeDialog from "@/components/AddWorktreeDialog";

vi.mock("@/lib/api", () => ({
  listProjectWorktreeStartPoints: vi.fn(async () => ({
    startPoints: [
      {
        value: "refs/heads/main",
        sha: "0123456789abcdef",
        localRef: "main",
        remoteRefs: ["origin/main"],
      },
    ],
    defaultStartPoint: "refs/heads/main",
    gitError: null,
  })),
}));

vi.mock("@/lib/stores/theme", () => ({
  useThemeSettings: <T,>(selector: (state: { version: number }) => T) =>
    selector({ version: 0 }),
}));

describe("AddWorktreeDialog", () => {
  it("mounts the start-point popover inside the dialog-owned container", async () => {
    render(
      <AddWorktreeDialog
        projectId="project-1"
        projectName="Devbox"
        onAdd={vi.fn(async () => {})}
        onImport={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Start from" }),
      ).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("combobox", { name: "Start from" }));

    const heading = await screen.findByText("Branches");
    const popoverContent = heading.closest<HTMLElement>(
      '[data-slot="popover-content"]',
    );
    const portalContainer = document.querySelector<HTMLElement>(
      "[data-start-point-popover-container]",
    );

    expect(popoverContent).not.toBeNull();
    expect(portalContainer).not.toBeNull();
    expect(portalContainer).toContainElement(popoverContent);
  });

  it("submits sourceRef for selected branch start points", async () => {
    const onAdd = vi.fn(async () => {});
    render(
      <AddWorktreeDialog
        projectId="project-1"
        projectName="Devbox"
        onAdd={onAdd}
        onImport={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("origin/main");

    const createButtons = screen.getAllByRole("button", { name: "Create" });
    await userEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        expect.any(String),
        "refs/heads/main",
        "origin/main",
      );
    });
  });

  it("omits sourceRef for custom start points", async () => {
    const onAdd = vi.fn(async () => {});
    render(
      <AddWorktreeDialog
        projectId="project-1"
        projectName="Devbox"
        onAdd={onAdd}
        onImport={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );

    await screen.findByText("origin/main");

    await userEvent.click(screen.getByRole("combobox", { name: "Start from" }));
    await userEvent.click(screen.getByText("Custom ref…"));
    const textboxes = screen.getAllByRole("textbox");
    await userEvent.type(textboxes[textboxes.length - 1], "origin/release");
    const createButtons = screen.getAllByRole("button", { name: "Create" });
    await userEvent.click(createButtons[createButtons.length - 1]);

    await waitFor(() => {
      expect(onAdd).toHaveBeenCalledWith(
        expect.any(String),
        "origin/release",
        undefined,
      );
    });
  });
});
