import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SnapshotUnavailableNotice from "./SnapshotUnavailableNotice";
import {
  resetConnectionStoreForTests,
  useConnectionStore,
} from "@/lib/stores/connection";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();

vi.mock("@/lib/events", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/events")>("@/lib/events");
  return {
    ...actual,
    getEventClient: () => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      on: vi.fn(() => vi.fn()),
    }),
  };
});

describe("SnapshotUnavailableNotice", () => {
  afterEach(() => {
    resetConnectionStoreForTests();
    mockConnect.mockClear();
    mockDisconnect.mockClear();
  });

  it("renders nothing without a snapshot error", () => {
    const { container } = render(<SnapshotUnavailableNotice />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the failure and retries via reconnect", async () => {
    useConnectionStore.setState({
      snapshotError: {
        scope: "chat_conversations",
        message: "database is locked",
      },
    });
    const user = userEvent.setup();
    render(<SnapshotUnavailableNotice />);

    expect(
      screen.getByText("Server state could not be loaded"),
    ).toBeInTheDocument();
    expect(screen.getByText("chat_conversations")).toBeInTheDocument();
    expect(screen.getByText("database is locked")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });
});
