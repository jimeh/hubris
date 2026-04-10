import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
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
import SortableTabView from "./SortableTabView";

type SortableTabStripProps = {
  worktreeId: string;
  tabs: Tab[];
  activeTabId: string | null;
  tabListRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onActivate: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (orderedIds: string[]) => Promise<void>;
  onRenameTerminalTab?: (tabId: string, label: string) => Promise<void>;
  onResetTerminalTabName?: (tabId: string) => Promise<void>;
  dirtyTabIds?: string[];
  lockedTabIds?: string[];
};

export default function SortableTabStrip({
  worktreeId,
  tabs,
  activeTabId,
  tabListRef,
  onScroll,
  onActivate,
  onPin,
  onClose,
  onReorder,
  onRenameTerminalTab = async () => {},
  onResetTerminalTabName = async () => {},
  dirtyTabIds = [],
  lockedTabIds = [],
}: SortableTabStripProps) {
  const [dragging, setDragging] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [activeDragWidth, setActiveDragWidth] = useState<number | null>(null);
  const [renameTabId, setRenameTabId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const dirtyTabIdSet = useMemo(() => new Set(dirtyTabIds), [dirtyTabIds]);
  const lockedTabIdSet = useMemo(() => new Set(lockedTabIds), [lockedTabIds]);
  const theme = useThemeSettings((state) => state.activeTheme);
  const tabLabelMode = useTerminalSettings(
    (state) => state.settings.tabLabelMode,
  );
  const gitStatus = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktreeId]?.gitStatus ?? null,
  );
  const sortableItems = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const tabPresentations = useMemo(
    () =>
      Object.fromEntries(
        tabs.map((tab) => [
          tab.id,
          presentTab(tab, theme, gitStatus, tabLabelMode),
        ]),
      ),
    [gitStatus, tabLabelMode, tabs, theme],
  );
  const activeDragTab = useMemo(
    () => tabs.find((tab) => tab.id === activeDragId) ?? null,
    [activeDragId, tabs],
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
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  function clearDragState(): void {
    setDragging(false);
    setActiveDragId(null);
    setActiveDragWidth(null);
  }

  function handleDragStart(event: DragStartEvent): void {
    setDragging(true);
    setActiveDragId(String(event.active.id));
    setActiveDragWidth(event.active.rect.current.initial?.width ?? null);
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    clearDragState();

    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = tabs.findIndex((tab) => tab.id === active.id);
    const newIndex = tabs.findIndex((tab) => tab.id === over.id);
    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const next = arrayMove(tabs, oldIndex, newIndex);
    void onReorder(next.map((tab) => tab.id));
  }

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
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={clearDragState}
      >
        <SortableContext
          items={sortableItems}
          strategy={horizontalListSortingStrategy}
        >
          <div
            ref={tabListRef}
            role="tablist"
            className="flex items-center gap-1 overflow-x-auto overflow-y-hidden"
            data-tab-list="true"
            data-tab-dragging={dragging || undefined}
            onScroll={onScroll}
          >
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
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
            ))}
          </div>
        </SortableContext>

        <DragOverlay>
          {activeDragTab ? (
            <SortableTabView
              tabId={activeDragTab.id}
              label={
                tabPresentations[activeDragTab.id]?.label ?? activeDragTab.label
              }
              labelSuffix={tabPresentations[activeDragTab.id]?.labelSuffix}
              statusLabel={tabPresentations[activeDragTab.id]?.statusLabel}
              title={
                tabPresentations[activeDragTab.id]?.title ?? activeDragTab.label
              }
              iconKind={tabPresentations[activeDragTab.id]?.iconKind}
              iconPath={tabPresentations[activeDragTab.id]?.iconPath}
              iconId={tabPresentations[activeDragTab.id]?.iconId}
              toneClass={tabPresentations[activeDragTab.id]?.toneClass}
              isActive={activeDragTab.id === activeTabId}
              preview={activeDragTab.preview}
              dirty={dirtyTabIdSet.has(activeDragTab.id)}
              notification={
                activeDragTab.type === "terminal" &&
                !!activeDragTab.has_notification
              }
              locked={lockedTabIdSet.has(activeDragTab.id)}
              isOverlay
              width={activeDragWidth}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

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
              Custom names override active process and process title labels.
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
