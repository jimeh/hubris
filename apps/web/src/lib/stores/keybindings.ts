import { create } from "zustand";
import { getKeybindings, replaceKeybindings } from "@/lib/api";
import { getEventClient } from "@/lib/events";
import type {
  KeybindingEntry,
  KeybindingsState,
  KeybindingsStatus,
} from "@/lib/contracts/sse.generated";
import {
  buildKeybindingRegistry,
  type KeybindingRegistry,
} from "@/lib/keybindings/registry";

const DEFAULT_KEYBINDINGS_STATUS = {
  kind: "ok",
  message: null,
  writesBlocked: false,
} satisfies KeybindingsStatus;

type KeybindingsStoreState = {
  generation: string;
  keybindings: KeybindingEntry[];
  registry: KeybindingRegistry;
  status: KeybindingsStatus;
  initialize: () => () => void;
  replaceUserKeybindings: (
    keybindings: KeybindingEntry[],
  ) => Promise<KeybindingsState>;
};

const initialState = {
  generation: "0",
  keybindings: [],
  registry: buildKeybindingRegistry([]),
  status: DEFAULT_KEYBINDINGS_STATUS,
} satisfies Pick<
  KeybindingsStoreState,
  "generation" | "keybindings" | "registry" | "status"
>;

export const useKeybindingsStore = create<KeybindingsStoreState>(() => ({
  ...initialState,
  initialize() {
    const events = getEventClient();
    const unsubscribers = [
      events.on("snapshot", (data) => {
        commitKeybindingsState({
          generation: data.keybindingsGeneration,
          keybindings: data.keybindings,
          status: data.keybindingsStatus,
        });
      }),
      events.on("keybindings_updated", (data) => {
        commitKeybindingsState(data);
      }),
    ];

    void getKeybindings()
      .then((state) => commitKeybindingsState(state))
      .catch(() => {});

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  },
  async replaceUserKeybindings(keybindings) {
    const state = await replaceKeybindings(keybindings);
    commitKeybindingsState(state);
    return state;
  },
}));

function commitKeybindingsState(state: KeybindingsState): void {
  useKeybindingsStore.setState((current) => {
    if (isOlderGeneration(state.generation, current.generation)) {
      return current;
    }

    return {
      generation: state.generation,
      keybindings: state.keybindings,
      registry: buildKeybindingRegistry(state.keybindings),
      status: state.status,
    };
  });
}

function isOlderGeneration(next: string, current: string): boolean {
  const nextValue = BigInt(next);
  const currentValue = BigInt(current);
  return nextValue < currentValue;
}

let initialized = false;
let cleanup: (() => void) | null = null;

export function initializeKeybindingsStore(): void {
  if (initialized) return;
  initialized = true;
  cleanup = useKeybindingsStore.getState().initialize();
}

export function resetKeybindingsStoreForTests(): void {
  cleanup?.();
  cleanup = null;
  initialized = false;
  useKeybindingsStore.setState(initialState);
}
