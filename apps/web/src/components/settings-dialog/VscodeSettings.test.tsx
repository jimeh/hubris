import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VscodeStatus } from "@/lib/api";
import {
  resetSettingsStoreForTests,
  useSettingsStore,
} from "@/lib/stores/settings";
import { resetVscodeStoreForTests, setVscodeStatus } from "@/lib/stores/vscode";
import VscodeSettings from "./VscodeSettings";

const mockCheckVscodeUpdate = vi.fn();
const mockInstallVscode = vi.fn();
const mockStartVscode = vi.fn();
const mockStopVscode = vi.fn();
const mockRestartVscode = vi.fn();
const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    checkVscodeUpdate: () => mockCheckVscodeUpdate(),
    installVscode: (version?: string, force?: boolean) =>
      mockInstallVscode(version, force),
    startVscode: () => mockStartVscode(),
    stopVscode: () => mockStopVscode(),
    restartVscode: () => mockRestartVscode(),
  };
});

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
    warning: vi.fn(),
  },
}));

function makeRuntimeStatus(
  overrides: Partial<VscodeStatus["vscodeCli"]> = {},
): VscodeStatus["vscodeCli"] {
  return {
    supported: true,
    installedVersion: null,
    processStatus: "stopped",
    latest: null,
    installProgress: null,
    message: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<VscodeStatus> = {}): VscodeStatus {
  return {
    selectedRuntime: "vscodeCli",
    codeServer: makeRuntimeStatus(),
    vscodeCli: makeRuntimeStatus(),
    ...overrides,
  };
}

describe("VscodeSettings", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          settings: useSettingsStore.getState().settings,
          generation: "1",
          status: {
            kind: "ok",
            writesBlocked: false,
            message: null,
          },
        }),
      })),
    );
    resetSettingsStoreForTests();
    resetVscodeStoreForTests();
    useSettingsStore.getState().updateVscode({ runtime: "vscodeCli" });
    mockCheckVscodeUpdate.mockReset();
    mockInstallVscode.mockReset();
    mockStartVscode.mockReset();
    mockStopVscode.mockReset();
    mockRestartVscode.mockReset();
    mockToastError.mockReset();
    mockToastSuccess.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the selected runtime and install state when not installed", async () => {
    setVscodeStatus(makeStatus());

    render(<VscodeSettings />);

    expect(screen.getByText("Runtime")).toBeInTheDocument();
    expect(screen.getByText("Installation")).toBeInTheDocument();
    expect(screen.getByText("Process")).toBeInTheDocument();
    expect(await screen.findAllByText("Not installed")).not.toHaveLength(0);
    expect(screen.getByText(/Hubris keeps/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Install latest" }),
    ).toBeEnabled();
  });

  it("renders install progress for the selected runtime", async () => {
    setVscodeStatus(
      makeStatus({
        vscodeCli: makeRuntimeStatus({
          processStatus: "installing",
          installProgress: {
            phase: "downloading",
            percent: 42,
            downloadedBytes: 42 * 1024 * 1024,
            totalBytes: 100 * 1024 * 1024,
          },
        }),
      }),
    );

    render(<VscodeSettings />);

    expect(await screen.findByText("Downloading runtime")).toBeInTheDocument();
    expect(screen.getByText(/Downloading VS Code CLI 42%/)).toBeInTheDocument();
    expect(screen.getByLabelText("Install progress")).toBeInTheDocument();
  });

  it("checks for updates and offers an upgrade when a newer version exists", async () => {
    const user = userEvent.setup();
    setVscodeStatus(
      makeStatus({
        vscodeCli: makeRuntimeStatus({
          installedVersion: "1.114.0",
        }),
      }),
    );
    mockCheckVscodeUpdate.mockResolvedValue(
      makeStatus({
        vscodeCli: makeRuntimeStatus({
          installedVersion: "1.114.0",
          latest: {
            latestVersion: "1.115.0",
            updateAvailable: true,
          },
        }),
      }),
    );

    render(<VscodeSettings />);

    await screen.findByText("Official VS Code CLI: 1.114.0");
    await user.click(screen.getByRole("button", { name: "Check for Update" }));

    expect(mockCheckVscodeUpdate).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "Upgrade to 1.115.0" }),
    ).toBeInTheDocument();
  });

  it("switches runtime selection through settings", async () => {
    const user = userEvent.setup();
    setVscodeStatus(
      makeStatus({
        codeServer: makeRuntimeStatus({
          installedVersion: "4.114.1",
          processStatus: "running",
        }),
      }),
    );

    render(<VscodeSettings />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByText("coder/code-server"));

    expect(useSettingsStore.getState().settings.vscode.runtime).toBe(
      "codeServer",
    );
    expect(
      await screen.findByText("coder/code-server: 4.114.1"),
    ).toBeInTheDocument();
  });

  it("offers reinstall for the selected runtime", async () => {
    const user = userEvent.setup();
    setVscodeStatus(
      makeStatus({
        selectedRuntime: "codeServer",
        codeServer: makeRuntimeStatus({
          installedVersion: "4.114.1",
          processStatus: "running",
        }),
      }),
    );
    useSettingsStore.getState().updateVscode({ runtime: "codeServer" });
    mockInstallVscode.mockResolvedValue(
      makeStatus({
        selectedRuntime: "codeServer",
        codeServer: makeRuntimeStatus({
          installedVersion: "4.114.1",
          processStatus: "installing",
        }),
      }),
    );

    render(<VscodeSettings />);

    await user.click(screen.getByRole("button", { name: "Reinstall" }));

    await waitFor(() => {
      expect(mockInstallVscode).toHaveBeenCalledWith("4.114.1", true);
    });
  });
});
