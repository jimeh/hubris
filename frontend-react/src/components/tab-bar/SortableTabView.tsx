import {
  forwardRef,
  memo,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { X } from "lucide-react";
import { cn } from "$lib/utils";
import type { TabViewProps } from "./types";

const SortableTabView = memo(
  forwardRef<HTMLDivElement, TabViewProps>(function SortableTabView(
    {
      tabId,
      label,
      isActive,
      dragging = false,
      isOverlay = false,
      width,
      style,
      onActivateTab,
      onCloseTab,
      className,
      onKeyDown,
      role: _role,
      tabIndex: providedTabIndex,
      ...divProps
    },
    ref,
  ) {
    const mergedStyle =
      width == null
        ? style
        : ({ ...(style ?? {}), width } satisfies CSSProperties);

    function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
      onKeyDown?.(event);
      if (event.defaultPrevented) {
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivateTab?.(tabId);
      }
    }

    function handleClick(event: MouseEvent<HTMLDivElement>): void {
      if (event.defaultPrevented) {
        return;
      }

      onActivateTab?.(tabId);
    }

    return (
      <div
        ref={ref}
        style={mergedStyle}
        className={cn(
          "inline-flex cursor-default select-none items-center gap-1.5 whitespace-nowrap py-2 pl-3 pr-2.5 text-sm transition-colors",
          isActive
            ? "bg-tab-active text-tab-active-foreground shadow-[inset_0_-2px_0_var(--tab-active-border)]"
            : dragging
              ? "text-tab-inactive-foreground"
              : "text-tab-inactive-foreground hover:text-foreground",
          isOverlay && "pointer-events-none opacity-50",
          className,
        )}
        data-tab-drag-item="true"
        data-tab-overlay={isOverlay || undefined}
        {...divProps}
        role="tab"
        tabIndex={isOverlay ? -1 : (providedTabIndex ?? 0)}
        aria-selected={isActive}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      >
        <span>{label}</span>
        {isOverlay || !onCloseTab ? null : (
          <button
            type="button"
            aria-label={`Close ${label}`}
            className="rounded-sm opacity-60 hover:opacity-100"
            tabIndex={-1}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onCloseTab(tabId);
            }}
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }),
);

SortableTabView.displayName = "SortableTabView";

export default SortableTabView;
