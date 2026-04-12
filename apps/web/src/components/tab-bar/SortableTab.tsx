import { memo, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import SortableTabView from "./SortableTabView";

type SortableTabProps = {
  tabId: string;
  label: string;
  labelSuffix?: string;
  statusLabel?: string;
  title?: string;
  iconKind?: "terminal" | "material" | "browser";
  iconPath?: string;
  iconId?: string;
  toneClass?: string;
  isActive: boolean;
  preview: boolean;
  dirty: boolean;
  notification: boolean;
  locked: boolean;
  dragging: boolean;
  canRenameTerminal?: boolean;
  canResetTerminalName?: boolean;
  onBeginRenameTerminal?: (tabId: string) => void;
  onResetTerminalName?: (tabId: string) => void;
  onActivateTab: (tabId: string) => void;
  onPinTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
};

const SortableTab = memo(function SortableTab({
  tabId,
  label,
  labelSuffix,
  statusLabel,
  title,
  iconKind,
  iconPath,
  iconId,
  toneClass,
  isActive,
  preview,
  dirty,
  notification,
  locked,
  dragging,
  canRenameTerminal,
  canResetTerminalName,
  onBeginRenameTerminal,
  onResetTerminalName,
  onActivateTab,
  onPinTab,
  onCloseTab,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tabId });

  const style: CSSProperties = {
    transform: isDragging ? undefined : CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
    opacity: isDragging ? 0 : undefined,
    pointerEvents: isDragging ? "none" : undefined,
  };

  const tabView = (
    <SortableTabView
      ref={setNodeRef}
      style={style}
      tabId={tabId}
      label={label}
      labelSuffix={labelSuffix}
      statusLabel={statusLabel}
      title={title}
      iconKind={iconKind}
      iconPath={iconPath}
      iconId={iconId}
      toneClass={toneClass}
      isActive={isActive}
      preview={preview}
      dirty={dirty}
      notification={notification}
      locked={locked}
      dragging={dragging}
      onActivateTab={onActivateTab}
      onPinTab={onPinTab}
      onCloseTab={onCloseTab}
      {...attributes}
      {...listeners}
    />
  );

  if (!canRenameTerminal) {
    return tabView;
  }

  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>{tabView}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onBeginRenameTerminal?.(tabId)}>
          Rename…
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!canResetTerminalName}
          onSelect={() => onResetTerminalName?.(tabId)}
        >
          Reset Name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

export default SortableTab;
