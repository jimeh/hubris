import {
  forwardRef,
  memo,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { Globe, Lock, MessageSquare, Terminal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TabViewProps } from "./types";

const SortableTabView = memo(
  forwardRef<HTMLDivElement, TabViewProps>(function SortableTabView(
    {
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
      paneFocused = true,
      preview = false,
      dirty = false,
      notification = false,
      locked = false,
      dragging = false,
      isOverlay = false,
      showCloseButton = false,
      width,
      style,
      onActivateTab,
      onPinTab,
      onCloseTab,
      className,
      onKeyDown,
      role: _role,
      tabIndex: providedTabIndex,
      ...divProps
    },
    ref,
  ) {
    const mutedActiveBorderClass =
      "shadow-[inset_0_-2px_0_color-mix(in_srgb,_var(--tab-active-border)_55%,_transparent)]";
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

    function handleDoubleClick(event: MouseEvent<HTMLDivElement>): void {
      if (event.defaultPrevented || !preview) {
        return;
      }

      onPinTab?.(tabId);
    }

    function renderIcon() {
      switch (iconKind) {
        case "terminal":
          return (
            <Terminal
              className="h-4 w-4 shrink-0 text-muted-foreground"
              data-testid="tab-terminal-icon"
              aria-hidden="true"
            />
          );
        case "browser":
          return (
            <Globe
              className="h-4 w-4 shrink-0 text-muted-foreground"
              data-testid="tab-browser-icon"
              aria-hidden="true"
            />
          );
        case "chat":
          return (
            <MessageSquare
              className="h-4 w-4 shrink-0 text-muted-foreground"
              data-testid="tab-chat-icon"
              aria-hidden="true"
            />
          );
        case "material":
          return iconPath ? (
            <img
              src={iconPath}
              alt=""
              className="hubris-explorer-icon h-4 w-4 shrink-0 object-contain"
              data-testid="tab-file-icon"
              data-icon-id={iconId}
              aria-hidden="true"
              draggable={false}
            />
          ) : null;
        default:
          return null;
      }
    }

    return (
      <div
        ref={ref}
        style={mergedStyle}
        title={title}
        className={cn(
          "inline-flex h-full min-h-9 min-w-0 shrink-0 max-w-72 cursor-default select-none items-center gap-1.5 overflow-hidden whitespace-nowrap pl-3 pr-2.5 text-sm transition-colors",
          isActive
            ? paneFocused
              ? "bg-tab-active text-tab-active-foreground shadow-[inset_0_-2px_0_var(--tab-active-border)]"
              : cn("text-tab-inactive-foreground", mutedActiveBorderClass)
            : dragging
              ? "text-tab-inactive-foreground"
              : "text-tab-inactive-foreground hover:text-foreground",
          isOverlay && "pointer-events-none",
          className,
        )}
        data-tab-drag-item="true"
        data-tab-overlay={isOverlay || undefined}
        {...divProps}
        role="tab"
        tabIndex={isOverlay ? -1 : (providedTabIndex ?? 0)}
        aria-selected={isActive}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        {renderIcon()}
        {dirty ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-sky-400"
            aria-hidden="true"
          />
        ) : notification ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-notification-dot"
            aria-hidden="true"
          />
        ) : null}
        <span
          className={cn("inline-flex min-w-0 items-baseline gap-1", toneClass)}
        >
          <span className={cn("truncate", preview && "italic")}>{label}</span>
          {labelSuffix ? (
            <span className="shrink-0 text-[0.92em] opacity-80">
              {labelSuffix}
            </span>
          ) : null}
          {statusLabel ? (
            <span
              className="shrink-0 text-[0.7em] font-semibold tracking-[0.14em]"
              data-testid="tab-status-label"
            >
              {statusLabel}
            </span>
          ) : null}
        </span>
        {locked ? (
          <>
            <Lock
              className="h-3 w-3 shrink-0 text-muted-foreground/80"
              data-testid="tab-lock-icon"
              aria-hidden="true"
            />
            <span className="sr-only">read-only</span>
          </>
        ) : null}
        {!onCloseTab || (isOverlay && !showCloseButton) ? null : (
          <button
            type="button"
            aria-label={`Close ${title ?? label}`}
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
