import type { ComponentPropsWithoutRef } from "react";

export type TabViewProps = {
  tabId: string;
  label: string;
  labelSuffix?: string;
  statusLabel?: string;
  title?: string;
  iconKind?: "terminal" | "material";
  iconPath?: string;
  iconId?: string;
  toneClass?: string;
  isActive: boolean;
  preview?: boolean;
  dirty?: boolean;
  locked?: boolean;
  dragging?: boolean;
  isOverlay?: boolean;
  width?: number | null;
  onActivateTab?: (tabId: string) => void;
  onPinTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
} & Omit<ComponentPropsWithoutRef<"div">, "onClick" | "children">;
