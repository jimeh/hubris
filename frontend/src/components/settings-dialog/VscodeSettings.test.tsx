import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeServerStatus } from "@/lib/api";
import {
  resetCodeServerStoreForTests,
  setCodeServerStatus,
} from "@/lib/stores/codeServer";
import VscodeSettings from "./VscodeSettings";

const mockCheckCodeServerUpdate = vi.fn();
const mockInstallCodeServer = vi.fn();
const mockStartCodeServer = vi.fn();
const mockStopCodeServer = vi.fn();
const mockRestartCodeServer = vi.fn();
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock("@/lib/api", () => ({
  checkCodeServerUpdate: () => mockCheckCodeServerUpdate(),
  installCodeServer: (version?: string) => mockInstallCodeServer(version),
  startCodeServer: () => mockStartCodeServer(),
  stopCodeServer: () => mockStopCodeServer(),
  restartCodeServer: () => mockRestartCodeServer(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

function makeStatus(
  overrides: Partial<CodeServerStatus> = {},
): CodeServerStatus {
  return {
    supported: true,
    installedVersion: null,
    processStatus: "stopped" as const,
    latest: null,
    installProgress: null,
    message: null,
    ...overrides,
  };
}

describe("VscodeSettings", () => {
  beforeEach(() => {
    resetCodeServerStoreForTests();
    mockCheckCodeServerUpdate.mockReset();
    mockInstallCodeServer.mockReset();
    mockStartCodeServer.mockReset();
    mockStopCodeServer.mockReset();
    mockRestartCodeServer.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  it("shows the install state when code-server is not installed", async () => {
    setCodeServerStatus(makeStatus());

    render(<VscodeSettings />);

    expect(screen.getByText("Installation")).toBeInTheDocument();
    expect(screen.getByText("Process")).toBeInTheDocument();
    expect(await screen.findByText("Not installed")).toBeInTheDocument();
    expect(screen.getByText("Managed by")).toBeInTheDocument();
    expect(
      screen.getByText("coder/code-server", { selector: "code" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Install latest" }),
    ).toBeEnabled();
  });

  it("renders install progress from the shared code-server store", async () => {
    setCodeServerStatus(
      makeStatus({
        processStatus: "installing",
        installProgress: {
          phase: "downloading",
          percent: 42,
          downloadedBytes: 42 * 1024 * 1024,
          totalBytes: 100 * 1024 * 1024,
        },
      }),
    );

    render(<VscodeSettings />);

    expect(await screen.findByText("Downloading runtime")).toBeInTheDocument();
    expect(
      screen.getByText(/Downloading coder\/code-server 42%/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Install progress")).toBeInTheDocument();
  });

  it("checks for updates and offers an upgrade when a newer version exists", async () => {
    const user = userEvent.setup();
    setCodeServerStatus(
      makeStatus({
        installedVersion: "4.113.0",
      }),
    );
    mockCheckCodeServerUpdate.mockResolvedValue(
      makeStatus({
        installedVersion: "4.113.0",
        latest: {
          latestVersion: "4.114.1",
          updateAvailable: true,
        },
      }),
    );

    render(<VscodeSettings />);

    await screen.findByText("4.113.0");
    await user.click(screen.getByRole("button", { name: "Check for Update" }));

    expect(mockCheckCodeServerUpdate).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "Upgrade to 4.114.1" }),
    ).toBeInTheDocument();
  });

  it("shows runtime controls for a running installation", async () => {
    const user = userEvent.setup();
    setCodeServerStatus(
      makeStatus({
        installedVersion: "4.114.1",
        processStatus: "running",
      }),
    );
    mockRestartCodeServer.mockResolvedValue(
      makeStatus({
        installedVersion: "4.114.1",
        processStatus: "running",
      }),
    );

    render(<VscodeSettings />);

    await screen.findByText("4.114.1");

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(mockRestartCodeServer).toHaveBeenCalledTimes(1);
    });
  });
});
