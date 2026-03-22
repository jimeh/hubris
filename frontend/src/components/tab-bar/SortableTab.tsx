import { memo, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import SortableTabView from "./SortableTabView";

type SortableTabProps = {
  tabId: string;
  label: string;
  isActive: boolean;
  preview: boolean;
  dirty: boolean;
  dragging: boolean;
  onActivateTab: (tabId: string) => void;
  onPinTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
};

const SortableTab = memo(function SortableTab({
  tabId,
  label,
  isActive,
  preview,
  dirty,
  dragging,
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

  return (
    <SortableTabView
      ref={setNodeRef}
      style={style}
      tabId={tabId}
      label={label}
      isActive={isActive}
      preview={preview}
      dirty={dirty}
      dragging={dragging}
      onActivateTab={onActivateTab}
      onPinTab={onPinTab}
      onCloseTab={onCloseTab}
      {...attributes}
      {...listeners}
    />
  );
});

export default SortableTab;
