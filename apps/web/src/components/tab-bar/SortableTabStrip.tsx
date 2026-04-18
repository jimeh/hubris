import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useMemo, useState, type RefObject, type UIEventHandler } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useThemeSettings } from "@/lib/stores/theme";
import { useTerminalSettings } from "@/lib/stores/terminal";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { presentTab } from "@/lib/tabPresentation";
import type { Tab } from "@/lib/types";
import SortableTab from "./SortableTab";

type SortableTabStripProps = {
  worktreeId: string;
  paneId: string;
  tabBarDropTargetId: string;
  tabs: Tab[];
  activeTabId: string | null;
  paneFocused?: boolean;
  tabListRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onActivate: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder?: (orderedIds: string[]) => Promise<void>;
  onRenameTerminalTab?: (tabId: string, label: string) => Promise<void>;
  onResetTerminalTabName?: (tabId: string) => Promise<void>;
  dirtyTabIds?: string[];
  lockedTabIds?: string[];
  dragging?: boolean;
  draggingTabId?: string | null;
  dragOverId?: string | null;
};

export default function SortableTabStrip({
  worktreeId,
  paneId,
  tabBarDropTargetId,
  tabs,
  activeTabId,
  paneFocused = true,
  tabListRef,
  onScroll,
  onActivate,
  onPin,
  onClose,
  onReorder: _onReorder,
  onRenameTerminalTab = async () => {},
  onResetTerminalTabName = async () => {},
  dirtyTabIds = [],
  lockedTabIds = [],
  dragging = false,
  draggingTabId = null,
  dragOverId = null,
}: SortableTabStripProps) {
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const dirtyTabIdSet = useMemo(() => new Set(dirtyTabIds), [dirtyTabIds]);
  const lockedTabIdSet = useMemo(() => new Set(lockedTabIds), [lockedTabIds]);
  const theme = useThemeSettings((state) => state.activeTheme);
  const terminalSettings = useTerminalSettings((state) => state.settings);
  const gitStatus = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktreeId]?.gitStatus ?? null,
  );
  const sortableItems = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const insertionIndex = useMemo(() => {
    if (!dragging || !draggingTabId) {
      return null;
    }

    if (dragOverId === tabBarDropTargetId) {
      return tabs.length;
    }

    const overIndex = tabs.findIndex((tab) => tab.id === dragOverId);
    if (overIndex < 0) {
      return null;
    }

    const draggedIndex = tabs.findIndex((tab) => tab.id === draggingTabId);
    if (draggedIndex < 0) {
      return overIndex;
    }

    if (draggedIndex === overIndex) {
      return null;
    }

    return draggedIndex < overIndex ? overIndex + 1 : overIndex;
  }, [dragOverId, dragging, draggingTabId, tabBarDropTargetId, tabs]);
  const tabPresentations = useMemo(
    () =>
      Object.fromEntries(
        tabs.map((tab) => [
          tab.id,
          presentTab(tab, theme, gitStatus, terminalSettings),
        ]),
      ),
    [gitStatus, tabs, terminalSettings, theme],
  );
  const renameTab = useMemo(
    () =>
      renameTabId
        ? (tabs.find(
            (tab): tab is Extract<Tab, { type: "terminal" }> =>
              tab.id === renameTabId && tab.type === "terminal",
          ) ?? null)
        : null,
    [renameTabId, tabs],
  );
  function handleBeginRename(tabId: string): void {
    const tab = tabs.find(
      (candidate): candidate is Extract<Tab, { type: "terminal" }> =>
        candidate.id === tabId && candidate.type === "terminal",
    );
    if (!tab) {
      return;
    }

    setRenameTabId(tabId);
    setRenameValue(
      tab.customLabel ?? tabPresentations[tabId]?.label ?? tab.label,
    );
  }

  async function handleSubmitRename(): Promise<void> {
    if (!renameTabId) {
      return;
    }

    await onRenameTerminalTab(renameTabId, renameValue);
    setRenameTabId(null);
    setRenameValue("");
  }

  return (
    <>
      <SortableContext
        items={sortableItems}
        strategy={horizontalListSortingStrategy}
      >
        <div
          ref={tabListRef}
          role="tablist"
          className="flex h-full items-stretch gap-1 overflow-x-auto overflow-y-hidden"
          data-tab-list="true"
          data-tab-dragging={dragging || undefined}
          onScroll={onScroll}
        >
          {tabs.map((tab, index) => (
            <div
              key={`${paneId}:${tab.id}`}
              className="relative flex h-full shrink-0"
              data-tab-strip-item={tab.id}
            >
              {insertionIndex === index ? (
                <div
                  className="pointer-events-none absolute inset-y-1 -left-px z-10 w-0.5 rounded-full bg-primary"
                  data-tab-insert-indicator="true"
                />
              ) : null}
              <SortableTab
                tabId={tab.id}
                label={tabPresentations[tab.id]?.label ?? tab.label}
                labelSuffix={tabPresentations[tab.id]?.labelSuffix}
                statusLabel={tabPresentations[tab.id]?.statusLabel}
                title={tabPresentations[tab.id]?.title ?? tab.label}
                iconKind={tabPresentations[tab.id]?.iconKind}
                iconPath={tabPresentations[tab.id]?.iconPath}
                iconId={tabPresentations[tab.id]?.iconId}
                toneClass={tabPresentations[tab.id]?.toneClass}
                isActive={tab.id === activeTabId}
                paneFocused={paneFocused}
                preview={tab.preview}
                dirty={dirtyTabIdSet.has(tab.id)}
                notification={tab.type === "terminal" && !!tab.has_notification}
                locked={lockedTabIdSet.has(tab.id)}
                dragging={dragging}
                canRenameTerminal={tab.type === "terminal"}
                canResetTerminalName={
                  tab.type === "terminal" && !!tab.customLabel
                }
                onBeginRenameTerminal={handleBeginRename}
                onResetTerminalName={onResetTerminalTabName}
                onActivateTab={onActivate}
                onPinTab={onPin}
                onCloseTab={onClose}
              />
              {insertionIndex === tabs.length && index === tabs.length - 1 ? (
                <div
                  className="pointer-events-none absolute inset-y-1 -right-px z-10 w-0.5 rounded-full bg-primary"
                  data-tab-insert-indicator="true"
                />
              ) : null}
            </div>
          ))}
          {insertionIndex === 0 && tabs.length === 0 ? (
            <div
              className="pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-primary"
              data-tab-insert-indicator="true"
              style={{ left: 0 }}
            />
          ) : null}
        </div>
      </SortableContext>

      <Dialog
        open={renameTabId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTabId(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename Terminal Tab</DialogTitle>
            <DialogDescription>
              Custom names override smart names and terminal-provided titles
              until reset.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="terminal-tab-name">Name</Label>
            <Input
              id="terminal-tab-name"
              value={renameValue}
              onChange={(event) => setRenameValue(event.currentTarget.value)}
              placeholder={renameTab?.label ?? "Terminal"}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSubmitRename();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setRenameTabId(null);
                setRenameValue("");
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleSubmitRename()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
