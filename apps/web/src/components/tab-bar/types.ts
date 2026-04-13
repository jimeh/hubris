import type { ComponentPropsWithoutRef } from "react";

export type TabViewProps = {
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
  paneFocused?: boolean;
  preview?: boolean;
  dirty?: boolean;
  notification?: boolean;
  locked?: boolean;
  dragging?: boolean;
  isOverlay?: boolean;
  width?: number | null;
  onActivateTab?: (tabId: string) => void;
  onPinTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
} & Omit<ComponentPropsWithoutRef<"div">, "onClick" | "children">;
