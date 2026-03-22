import type { ComponentPropsWithoutRef } from "react";

export type TabViewProps = {
  tabId: string;
  label: string;
  isActive: boolean;
  preview?: boolean;
  dirty?: boolean;
  dragging?: boolean;
  isOverlay?: boolean;
  width?: number | null;
  onActivateTab?: (tabId: string) => void;
  onPinTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
} & Omit<ComponentPropsWithoutRef<"div">, "onClick" | "children">;
