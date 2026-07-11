export type TreeExpansionSource = {
  getSnapshot: (path: string) => boolean | undefined;
  subscribe: (path: string, listener: () => void) => () => void;
  setExpanded: (path: string, expanded: boolean) => void;
};

export type TreeExpansionStore = TreeExpansionSource & {
  setOnChange: (onChange?: (path: string, expanded: boolean) => void) => void;
};

/** Creates path-scoped expansion state whose listeners only hear their path. */
export function createTreeExpansionStore(
  initial: Readonly<Record<string, boolean>> = {},
  onChange?: (path: string, expanded: boolean) => void,
): TreeExpansionStore {
  const expandedByPath = new Map(Object.entries(initial));
  const listenersByPath = new Map<string, Set<() => void>>();
  let changeHandler = onChange;

  return {
    getSnapshot(path) {
      return expandedByPath.get(path);
    },
    subscribe(path, listener) {
      const listeners = listenersByPath.get(path) ?? new Set<() => void>();
      listeners.add(listener);
      listenersByPath.set(path, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByPath.delete(path);
        }
      };
    },
    setExpanded(path, expanded) {
      if (expandedByPath.get(path) === expanded) {
        return;
      }
      expandedByPath.set(path, expanded);
      for (const listener of listenersByPath.get(path) ?? []) {
        listener();
      }
      changeHandler?.(path, expanded);
    },
    setOnChange(nextOnChange) {
      changeHandler = nextOnChange;
    },
  };
}
