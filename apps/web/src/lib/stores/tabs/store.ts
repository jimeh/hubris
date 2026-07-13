import { create } from "zustand";
import {
  createTab,
  createTerminalTab,
  deleteTab,
  reorderTabs,
  updateTab,
} from "@/lib/api";
import {
  BLANK_BROWSER_URL,
  browserLabelFromUrl,
  normalizeBrowserUrl,
} from "@/lib/browserTabs";
import { scheduleDisposeTabModels } from "@/lib/monacoLazy";
import { setPaneSplitRatio, sortTabs } from "@/lib/tabLayout";
import {
  createLayoutActions,
  submitLayoutChange,
} from "@/lib/stores/tabs/layout-actions";
import {
  addTabIfMissing,
  agentChatOpenKey,
  disposeDesktopBrowserTab,
  findFileTab,
  findGitDiffTab,
  findPreviewTab,
  gitDiffOpenKey,
} from "@/lib/stores/tabs/open-flows";
import {
  ensureLayoutsForTabs,
  layoutEqual,
  resolvedPaneIdOrNew,
  tabsForWorktreeInternal,
} from "@/lib/stores/tabs/pane-layout";
import { initialSelection } from "@/lib/stores/tabs/persistence";
import {
  activateLocal,
  focusPaneLocal,
  nextStateAfterWorktreeLayout,
  removeFromState,
} from "@/lib/stores/tabs/selection";
import {
  normalizeTabs,
  replaceTabs,
  selectAllTabs,
} from "@/lib/stores/tabs/selectors";
import type { TabsState } from "@/lib/stores/tabs/types";
import type { BrowserTab, Tab } from "@/lib/types";

// Shares one createTab request across click+double-click for the same diff,
// letting the later event upgrade the eventual tab from preview to pinned.
const pendingGitDiffOpens = new Map<string, PendingGitDiffOpen>();
const pendingAgentChatOpens = new Map<string, Promise<Tab>>();

export function resetPendingTabOpens(): void {
  pendingGitDiffOpens.clear();
  pendingAgentChatOpens.clear();
}

type PendingGitDiffOpen = {
  state: {
    shouldPin: boolean;
  };
  promise: Promise<Tab>;
};

async function replacePreviewIfNeeded(
  state: TabsState,
  worktreeId: string,
  paneId: string,
): Promise<void> {
  const previewTab = findPreviewTab(selectAllTabs(state), worktreeId, paneId);
  if (!previewTab) {
    return;
  }

  scheduleDisposeTabModels(previewTab);
  useTabStore.setState((current) => removeFromState(current, previewTab.id));
  try {
    await deleteTab(previewTab.id);
  } catch {
    // Preview tab may already be gone.
  }
}

export const useTabStore = create<TabsState>((set, get) => {
  const selection = initialSelection();

  return {
    ...normalizeTabs([]),
    layoutsByWorktree: {},
    ...selection,
    updateAgentChatTitle(conversationId, title) {
      set((state) => {
        const nextTabs = selectAllTabs(state).map((tab) =>
          tab.type === "agent_chat" &&
          tab.conversationId === conversationId &&
          tab.label !== title
            ? { ...tab, label: title }
            : tab,
        );

        const changed = nextTabs.some(
          (tab, index) => tab !== selectAllTabs(state)[index],
        );
        return changed ? replaceTabs(state, nextTabs) : state;
      });
    },
    async addTerminal(worktreeId, requestedPaneId) {
      const paneId = resolvedPaneIdOrNew(get(), worktreeId, requestedPaneId);
      const tab = await createTerminalTab(worktreeId, paneId);
      set((state) => {
        const nextTabs = addTabIfMissing(selectAllTabs(state), tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          ...replaceTabs(state, nextTabs),
          layoutsByWorktree: nextLayoutsByWorktree,
          ...activateLocal(
            {
              ...state,
              ...replaceTabs(state, nextTabs),
              layoutsByWorktree: nextLayoutsByWorktree,
            } as TabsState,
            tab.id,
          ),
        };
      });
      return tab;
    },
    async setTerminalCustomLabel(id, customLabel) {
      const existing =
        selectAllTabs(get()).find((tab) => tab.id === id) ?? null;
      if (!existing || existing.type !== "terminal") {
        return existing;
      }

      const normalized = customLabel.trim();
      const nextCustomLabel = normalized.length > 0 ? normalized : null;
      set((state) =>
        replaceTabs(
          state,
          sortTabs(
            selectAllTabs(state).map((tab) =>
              tab.id === id && tab.type === "terminal"
                ? { ...tab, customLabel: nextCustomLabel }
                : tab,
            ),
          ),
        ),
      );

      try {
        return await updateTab(id, { customLabel: customLabel });
      } catch {
        return { ...existing, customLabel: nextCustomLabel };
      }
    },
    async resetTerminalCustomLabel(id) {
      return get().setTerminalCustomLabel(id, "");
    },
    async openFile(options) {
      const existing = findFileTab(
        selectAllTabs(get()),
        options.worktreeId,
        options.path,
      );
      if (existing) {
        if (!options.preview && existing.preview) {
          set((state) => ({
            ...replaceTabs(
              state,
              sortTabs(
                selectAllTabs(state).map((tab) =>
                  tab.id === existing.id ? { ...tab, preview: false } : tab,
                ),
              ),
            ),
            ...activateLocal(state, existing.id),
          }));
          try {
            return await updateTab(existing.id, { preview: false });
          } catch {
            return { ...existing, preview: false };
          }
        }

        set((state) => activateLocal(state, existing.id));
        return existing;
      }

      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      if (options.preview) {
        await replacePreviewIfNeeded(get(), options.worktreeId, paneId);
      }

      const tab = await createTab({
        type: "file",
        worktreeId: options.worktreeId,
        paneId: paneId,
        path: options.path,
        preview: options.preview,
      });
      set((state) => {
        const nextTabs = addTabIfMissing(selectAllTabs(state), tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          ...replaceTabs(state, nextTabs),
          layoutsByWorktree: nextLayoutsByWorktree,
          ...activateLocal(
            {
              ...state,
              ...replaceTabs(state, nextTabs),
              layoutsByWorktree: nextLayoutsByWorktree,
            } as TabsState,
            tab.id,
          ),
        };
      });
      return tab;
    },
    async openGitDiff(options) {
      const existing = findGitDiffTab(
        selectAllTabs(get()),
        options.worktreeId,
        options.path,
        options.scope,
        options.originalPath,
        options.commitId,
      );
      if (existing) {
        if (!options.preview && existing.preview) {
          set((state) => ({
            ...replaceTabs(
              state,
              sortTabs(
                selectAllTabs(state).map((tab) =>
                  tab.id === existing.id ? { ...tab, preview: false } : tab,
                ),
              ),
            ),
            ...activateLocal(state, existing.id),
          }));
          try {
            return await updateTab(existing.id, { preview: false });
          } catch {
            return { ...existing, preview: false };
          }
        }

        set((state) => activateLocal(state, existing.id));
        return existing;
      }

      const pendingKey = gitDiffOpenKey(options);
      const pending = pendingGitDiffOpens.get(pendingKey);
      if (pending) {
        if (!options.preview) {
          pending.state.shouldPin = true;
        }
        return pending.promise;
      }

      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      const pendingState = {
        shouldPin: !options.preview,
      };
      const pendingPromise = (async () => {
        if (options.preview) {
          await replacePreviewIfNeeded(get(), options.worktreeId, paneId);
        }

        const tab = await createTab({
          type: "git_diff",
          worktreeId: options.worktreeId,
          paneId: paneId,
          path: options.path,
          scope: options.scope,
          originalPath: options.originalPath ?? undefined,
          commitId: options.commitId ?? undefined,
          preview: options.preview,
        });
        set((state) => {
          const nextTabs = addTabIfMissing(selectAllTabs(state), tab);
          const nextLayoutsByWorktree = ensureLayoutsForTabs(
            nextTabs,
            state.layoutsByWorktree,
          );
          return {
            ...replaceTabs(state, nextTabs),
            layoutsByWorktree: nextLayoutsByWorktree,
            ...activateLocal(
              {
                ...state,
                ...replaceTabs(state, nextTabs),
                layoutsByWorktree: nextLayoutsByWorktree,
              } as TabsState,
              tab.id,
            ),
          };
        });

        if (!pendingState.shouldPin || !tab.preview) {
          return tab;
        }

        set((state) => ({
          ...replaceTabs(
            state,
            sortTabs(
              selectAllTabs(state).map((candidate) =>
                candidate.id === tab.id
                  ? { ...candidate, preview: false }
                  : candidate,
              ),
            ),
          ),
          ...activateLocal(state, tab.id),
        }));
        try {
          return await updateTab(tab.id, { preview: false });
        } catch {
          return { ...tab, preview: false };
        }
      })().finally(() => {
        pendingGitDiffOpens.delete(pendingKey);
      });

      pendingGitDiffOpens.set(pendingKey, {
        state: pendingState,
        promise: pendingPromise,
      });

      return pendingPromise;
    },
    async openBrowser(options) {
      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      const url = normalizeBrowserUrl(options.url ?? BLANK_BROWSER_URL, {
        allowBlank: true,
      });
      const tab = await createTab({
        type: "browser",
        worktreeId: options.worktreeId,
        paneId: paneId,
        url,
      });
      set((state) => {
        const nextTabs = addTabIfMissing(selectAllTabs(state), tab);
        const nextLayoutsByWorktree = ensureLayoutsForTabs(
          nextTabs,
          state.layoutsByWorktree,
        );
        return {
          ...replaceTabs(state, nextTabs),
          layoutsByWorktree: nextLayoutsByWorktree,
          ...activateLocal(
            {
              ...state,
              ...replaceTabs(state, nextTabs),
              layoutsByWorktree: nextLayoutsByWorktree,
            } as TabsState,
            tab.id,
          ),
        };
      });
      return tab;
    },
    async openAgentChat(options) {
      const existing =
        options.conversationId == null
          ? null
          : (selectAllTabs(get()).find(
              (tab) =>
                tab.type === "agent_chat" &&
                tab.worktreeId === options.worktreeId &&
                tab.conversationId === options.conversationId,
            ) ?? null);
      if (existing) {
        set((state) => activateLocal(state, existing.id));
        return existing;
      }

      const paneId = resolvedPaneIdOrNew(
        get(),
        options.worktreeId,
        options.paneId,
      );
      const pendingKey = agentChatOpenKey(options, paneId);
      const pending = pendingAgentChatOpens.get(pendingKey);
      if (pending) {
        return pending;
      }

      const pendingPromise = (async () => {
        const tab = await createTab({
          type: "agent_chat",
          worktreeId: options.worktreeId,
          paneId: paneId,
          conversationId: options.conversationId,
        });
        set((state) => {
          const nextTabs = addTabIfMissing(selectAllTabs(state), tab);
          const nextLayoutsByWorktree = ensureLayoutsForTabs(
            nextTabs,
            state.layoutsByWorktree,
          );
          return {
            ...replaceTabs(state, nextTabs),
            layoutsByWorktree: nextLayoutsByWorktree,
            ...activateLocal(
              {
                ...state,
                ...replaceTabs(state, nextTabs),
                layoutsByWorktree: nextLayoutsByWorktree,
              } as TabsState,
              tab.id,
            ),
          };
        });
        return tab;
      })().finally(() => {
        pendingAgentChatOpens.delete(pendingKey);
      });

      pendingAgentChatOpens.set(pendingKey, pendingPromise);
      return pendingPromise;
    },
    async setBrowserState(id, updates) {
      const existing =
        selectAllTabs(get()).find(
          (tab): tab is BrowserTab => tab.id === id && tab.type === "browser",
        ) ?? null;
      if (!existing) {
        return existing;
      }

      const nextUrl = updates.url
        ? normalizeBrowserUrl(updates.url, { allowBlank: true })
        : existing.url;
      const nextHistory = updates.history
        ? updates.history.map((entry) =>
            normalizeBrowserUrl(entry, { allowBlank: true }),
          )
        : existing.history;
      const nextHistoryIndex = updates.historyIndex ?? existing.historyIndex;
      if (nextHistory.length === 0 || nextHistoryIndex >= nextHistory.length) {
        throw new Error("historyIndex must point at an entry in history.");
      }
      const nextLabel =
        updates.label ?? existing.label ?? browserLabelFromUrl(nextUrl);

      if (
        nextLabel === existing.label &&
        nextUrl === existing.url &&
        nextHistoryIndex === existing.historyIndex &&
        nextHistory.length === existing.history.length &&
        nextHistory.every((entry, index) => entry === existing.history[index])
      ) {
        return existing;
      }

      const optimistic: BrowserTab = {
        ...existing,
        label: nextLabel,
        url: nextUrl,
        history: nextHistory,
        historyIndex: nextHistoryIndex,
      };
      set((state) =>
        replaceTabs(
          state,
          sortTabs(
            selectAllTabs(state).map((tab) =>
              tab.id === id ? optimistic : tab,
            ),
          ),
        ),
      );

      try {
        return (await updateTab(id, {
          label: nextLabel,
          url: nextUrl,
          history: nextHistory,
          historyIndex: nextHistoryIndex,
        })) as BrowserTab;
      } catch {
        return optimistic;
      }
    },
    async pin(id) {
      const existing =
        selectAllTabs(get()).find((tab) => tab.id === id) ?? null;
      if (!existing || !existing.preview) {
        return existing;
      }

      set((state) =>
        replaceTabs(
          state,
          sortTabs(
            selectAllTabs(state).map((tab) =>
              tab.id === id ? { ...tab, preview: false } : tab,
            ),
          ),
        ),
      );

      try {
        return await updateTab(id, { preview: false });
      } catch {
        return { ...existing, preview: false };
      }
    },
    async close(id) {
      const closingTab = selectAllTabs(get()).find(
        (candidate) => candidate.id === id,
      );
      if (!closingTab) {
        return;
      }

      set((state) => removeFromState(state, id));

      try {
        await deleteTab(id);
      } catch {
        // Already gone.
      }

      disposeDesktopBrowserTab(closingTab);
      scheduleDisposeTabModels(closingTab);
    },
    removeLocal(id) {
      const closingTab = selectAllTabs(get()).find(
        (candidate) => candidate.id === id,
      );
      set((state) => removeFromState(state, id));
      if (closingTab) {
        disposeDesktopBrowserTab(closingTab);
        scheduleDisposeTabModels(closingTab);
      }
    },
    activate(id) {
      const tab = selectAllTabs(get()).find((candidate) => candidate.id === id);
      set((state) => activateLocal(state, id));
      if (!tab) {
        return;
      }
    },
    focusPane(worktreeId, paneId) {
      set((state) => focusPaneLocal(state, worktreeId, paneId));
    },
    setSplitRatio(worktreeId, nodeId, ratio) {
      let changed = false;
      set((state) => {
        const layout = state.layoutsByWorktree[worktreeId];
        if (!layout) {
          return state;
        }

        const nextLayout = setPaneSplitRatio(layout, nodeId, ratio);
        if (layoutEqual(layout, nextLayout)) {
          return state;
        }
        changed = true;

        return {
          layoutsByWorktree: {
            ...state.layoutsByWorktree,
            [worktreeId]: nextLayout,
          },
        };
      });
      return changed;
    },
    async persistLayout(projectId, worktreeId) {
      const state = get();
      const layout = state.layoutsByWorktree[worktreeId];
      if (!layout) {
        return;
      }

      const serverState = await submitLayoutChange(
        projectId,
        worktreeId,
        layout,
        tabsForWorktreeInternal(selectAllTabs(state), worktreeId),
      );
      set((current) =>
        nextStateAfterWorktreeLayout(current, worktreeId, serverState),
      );
    },
    async reorder(worktreeId, paneId, orderedIds) {
      set((state) =>
        replaceTabs(
          state,
          sortTabs(
            selectAllTabs(state).map((tab) => {
              if (tab.worktreeId !== worktreeId || tab.paneId !== paneId) {
                return tab;
              }
              const index = orderedIds.indexOf(tab.id);
              return index >= 0 ? { ...tab, position: index + 1 } : tab;
            }),
          ),
        ),
      );

      await reorderTabs(worktreeId, paneId, orderedIds);
    },
    ...createLayoutActions(set, get),
  };
});
