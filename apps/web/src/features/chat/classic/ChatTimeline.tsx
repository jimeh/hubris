// Frozen classic renderer: no new investment; CopilotKit is the promoted default.

import {
  ChevronDown,
  ClipboardList,
  FilePenLine,
  GitCompare,
  LoaderCircle,
  MessageSquareText,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  PendingRequestCard,
  requestKindLabel,
} from "@/features/chat/classic/PendingRequestUi";
import { activityLabel, activityStatusLabel, itemMetadata } from "@/lib/chat/";
import {
  selectChatActivityDetailState,
  selectChatConversation,
  selectChatDetailState,
  selectChatDiffSummary,
  selectChatItem,
  selectChatItemOutput,
  selectChatItemOutputIds,
  selectChatMessage,
  selectChatPendingRequest,
  selectChatPlan,
  selectChatTimelineIds,
  selectChatWorkGroupSlice,
  useChatStore,
} from "@/lib/stores/chats";
import { useTabStore } from "@/lib/stores/tabs";
import type {
  ChatDiffSummary,
  ChatItem,
  ChatMessage,
  ChatPlan,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const AUTO_FOLLOW_THRESHOLD_PX = 96;

const CONTAINED_TIMELINE_ROW_STYLE: CSSProperties = {
  contain: "layout style paint",
  containIntrinsicSize: "0 10rem",
  contentVisibility: "auto",
};

function assistantStatusLabel(
  message: ChatMessage,
  streaming: boolean,
): string {
  if (streaming) {
    return "Responding";
  }

  if (message.status === "completed" && !message.contentText.trim()) {
    return "No response";
  }

  switch (message.status) {
    case "failed":
      return "Response failed";
    case "interrupted":
      return "Response interrupted";
    case "pending":
      return "Pending";
    default:
      return "Response ready";
  }
}

function assistantFallbackText(
  message: ChatMessage,
  streaming: boolean,
): string {
  if (streaming) {
    return "Working...";
  }

  if (message.status === "completed" && !message.contentText.trim()) {
    return "Codex completed without returning a response.";
  }

  switch (message.status) {
    case "failed":
      return "Codex stopped before returning a response.";
    case "interrupted":
      return "Response interrupted before Codex returned text.";
    default:
      return "";
  }
}

type PlanStep = {
  text: string;
  status: "pending" | "in_progress" | "completed";
};

function parsePlanSteps(plan: ChatPlan): PlanStep[] {
  try {
    const parsed = JSON.parse(plan.stepsJson);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((step) => {
        if (typeof step === "string") {
          return { text: step, status: "pending" as const };
        }
        if (!step || typeof step !== "object") {
          return null;
        }
        const record = step as Record<string, unknown>;
        const text =
          typeof record.text === "string"
            ? record.text
            : typeof record.description === "string"
              ? record.description
              : typeof record.title === "string"
                ? record.title
                : "";
        if (!text.trim()) {
          return null;
        }
        const rawStatus =
          typeof record.status === "string" ? record.status : "pending";
        const status =
          rawStatus === "completed" || rawStatus === "done"
            ? "completed"
            : rawStatus === "in_progress" ||
                rawStatus === "running" ||
                rawStatus === "current"
              ? "in_progress"
              : "pending";
        return { text, status };
      })
      .filter((step): step is PlanStep => Boolean(step))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function planTitle(plan: ChatPlan): string {
  return plan.kind === "active_task" ? "Plan" : "Proposed plan";
}

function diffStatsLabel(diff: ChatDiffSummary): string {
  const parts = [
    `${diff.changedFileCount} file${diff.changedFileCount === 1 ? "" : "s"}`,
  ];
  if (diff.additions != null) {
    parts.push(`+${diff.additions}`);
  }
  if (diff.deletions != null) {
    parts.push(`-${diff.deletions}`);
  }
  return parts.join(" · ");
}

function timelineRowLabel(
  kind: string,
  status: string | null | undefined,
): string {
  return status ? `${kind}: ${status}` : kind;
}

function getScrollViewport(root: HTMLDivElement | null): HTMLElement | null {
  return (
    root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
    null
  );
}

function isNearScrollBottom(viewport: HTMLElement): boolean {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    AUTO_FOLLOW_THRESHOLD_PX
  );
}

function scrollToBottom(viewport: HTMLElement): void {
  viewport.scrollTop = Math.max(
    0,
    viewport.scrollHeight - viewport.clientHeight,
  );
}

function useTimelineAutoFollow(rowIds: readonly string[]): {
  rootRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
} {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);
  const rafRef = useRef<number | null>(null);

  const scheduleFollow = useCallback(() => {
    if (!shouldFollowRef.current || rafRef.current !== null) {
      return;
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      const viewport = getScrollViewport(rootRef.current);
      if (viewport && shouldFollowRef.current) {
        scrollToBottom(viewport);
      }
    });
  }, []);

  useEffect(() => {
    const viewport = getScrollViewport(rootRef.current);
    if (!viewport) {
      return;
    }

    shouldFollowRef.current = isNearScrollBottom(viewport);
    const handleScroll = () => {
      shouldFollowRef.current = isNearScrollBottom(viewport);
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, []);

  useEffect(() => {
    scheduleFollow();
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [rowIds, scheduleFollow]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      scheduleFollow();
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [scheduleFollow]);

  return { rootRef, contentRef };
}

function TimelineRowShell({
  active = false,
  children,
  label,
  side = "left",
}: {
  active?: boolean;
  children: ReactNode;
  label: string;
  side?: "left" | "right";
}) {
  return (
    <div
      role="listitem"
      aria-label={label}
      data-testid="chat-timeline-row"
      data-active={active ? "true" : "false"}
      className={cn("flex", side === "right" ? "justify-end" : "justify-start")}
      style={active ? undefined : CONTAINED_TIMELINE_ROW_STYLE}
    >
      {children}
    </div>
  );
}

function ActivityIcon({ item }: { item: ChatItem }) {
  const className = "h-3.5 w-3.5";
  if (item.kind === "command_execution") {
    return <Terminal className={className} />;
  }
  if (item.kind === "file_change") {
    return <FilePenLine className={className} />;
  }
  return <Wrench className={className} />;
}

function UserTurn({ message }: { message: ChatMessage }) {
  return (
    <TimelineRowShell
      label={timelineRowLabel("User message", message.status)}
      side="right"
    >
      <div className="max-w-[min(42rem,82%)] rounded-xl border bg-muted/30 px-4 py-3">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          You
        </div>
        <div className="whitespace-pre-wrap text-sm leading-6">
          {message.contentText}
        </div>
      </div>
    </TimelineRowShell>
  );
}

function AssistantTurn({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming: boolean;
}) {
  const failed = message.status === "failed";
  const interrupted = message.status === "interrupted";
  const fallbackText = assistantFallbackText(message, streaming);
  const hasContent = message.contentText.trim().length > 0;

  return (
    <TimelineRowShell
      active={streaming}
      label={timelineRowLabel("Codex response", message.status)}
    >
      <div
        className={cn(
          "max-w-[min(46rem,92%)] space-y-3 rounded-xl border bg-card px-4 py-3 shadow-xs",
          failed && "border-destructive/40",
          interrupted && "border-muted-foreground/30",
        )}
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-primary",
              failed && "bg-destructive/10 text-destructive",
              interrupted && "bg-muted text-muted-foreground",
            )}
          >
            <MessageSquareText className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="text-sm font-medium">Codex</div>
            <div className="text-xs text-muted-foreground" aria-live="polite">
              {assistantStatusLabel(message, streaming)}
            </div>
          </div>
        </div>
        <div
          className={cn(
            "whitespace-pre-wrap text-sm leading-6",
            !hasContent && fallbackText && "text-muted-foreground",
            failed && "text-destructive",
          )}
        >
          {hasContent ? message.contentText : fallbackText}
        </div>
      </div>
    </TimelineRowShell>
  );
}

function ChatMessageRow({ messageId }: { messageId: string }) {
  const message = useChatStore((state) => selectChatMessage(state, messageId));
  if (!message) {
    return null;
  }

  return message.role === "user" ? (
    <UserTurn message={message} />
  ) : (
    <AssistantTurn
      message={message}
      streaming={message.status === "streaming"}
    />
  );
}

function ActivityOutputChunk({ outputId }: { outputId: string }) {
  const output = useChatStore((state) => selectChatItemOutput(state, outputId));
  if (!output) {
    return null;
  }
  return <>{output.contentText}</>;
}

function ActivityRow({
  conversationId,
  itemId,
  nested = false,
}: {
  conversationId: string;
  itemId: string;
  nested?: boolean;
}) {
  const item = useChatStore((state) => selectChatItem(state, itemId));
  const outputIds = useChatStore((state) =>
    selectChatItemOutputIds(state, itemId),
  );
  const detailState = useChatStore((state) =>
    selectChatActivityDetailState(state, itemId),
  );
  const ensureActivityLoaded = useChatStore(
    (state) => state.ensureActivityLoaded,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) {
      void ensureActivityLoaded(conversationId, itemId);
    }
  }, [conversationId, ensureActivityLoaded, itemId, open]);

  if (!item) {
    return null;
  }

  const running = item.status === "started" || item.status === "streaming";
  const failed = item.status === "failed";
  const hasOutputs = outputIds.length > 0;

  const content = (
    <div className={cn("w-full", !nested && "max-w-[min(46rem,92%)]")}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "rounded-xl border bg-muted/25 text-sm",
            failed && "border-destructive/40",
          )}
        >
          <CollapsibleTrigger className="flex w-full items-center gap-3 px-3 py-2 text-left">
            <div
              className={cn(
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
                running && "text-primary",
                failed && "text-destructive",
              )}
            >
              {running ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ActivityIcon item={item} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{activityLabel(item)}</div>
              <div className="truncate text-xs text-muted-foreground">
                {activityStatusLabel(item)}
                {item.summary ? ` · ${item.summary}` : ""}
              </div>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t px-3 py-3">
            {detailState.status === "loading" && !hasOutputs ? (
              <div className="text-xs text-muted-foreground">
                Loading activity output…
              </div>
            ) : null}
            {detailState.error ? (
              <div className="text-xs text-destructive">
                {detailState.error}
              </div>
            ) : null}
            {hasOutputs ? (
              <pre className="max-h-72 overflow-auto rounded-lg bg-background/80 p-3 text-xs leading-5 text-foreground">
                {outputIds.map((outputId) => (
                  <ActivityOutputChunk key={outputId} outputId={outputId} />
                ))}
              </pre>
            ) : detailState.status !== "loading" ? (
              <div className="text-xs text-muted-foreground">
                No output captured for this activity.
              </div>
            ) : null}
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );

  if (nested) {
    return content;
  }

  return (
    <TimelineRowShell
      active={running}
      label={timelineRowLabel(activityLabel(item), item.status)}
    >
      {content}
    </TimelineRowShell>
  );
}

function PendingRequestRow({ requestId }: { requestId: string }) {
  const request = useChatStore((state) =>
    selectChatPendingRequest(state, requestId),
  );
  if (!request) {
    return null;
  }
  return (
    <TimelineRowShell
      active={request.status === "pending" || request.status === "resolving"}
      label={timelineRowLabel(requestKindLabel(request), request.status)}
    >
      <div className="max-w-[min(46rem,92%)]">
        <PendingRequestCard request={request} />
      </div>
    </TimelineRowShell>
  );
}

function NestedPendingRequestCard({ requestId }: { requestId: string }) {
  const request = useChatStore((state) =>
    selectChatPendingRequest(state, requestId),
  );
  return request ? <PendingRequestCard request={request} compact /> : null;
}

function PlanRow({
  planId,
  nested = false,
}: {
  planId: string;
  nested?: boolean;
}) {
  const plan = useChatStore((state) => selectChatPlan(state, planId));
  if (!plan) {
    return null;
  }
  const steps = parsePlanSteps(plan);
  const streaming = plan.status === "streaming";
  const content = (
    <div className={cn("w-full", !nested && "max-w-[min(46rem,92%)]")}>
      <div className="rounded-xl border bg-muted/25 px-3 py-3 text-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {streaming ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ClipboardList className="h-3.5 w-3.5" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <div className="font-medium">{planTitle(plan)}</div>
              <div className="text-xs text-muted-foreground">
                {streaming ? "Writing plan" : "Plan ready"}
              </div>
            </div>
            {steps.length > 0 ? (
              <div className="space-y-1.5">
                {steps.map((step, index) => (
                  <div
                    key={`${index}-${step.text}`}
                    className="flex gap-2 text-xs"
                  >
                    <span className="mt-0.5 text-muted-foreground">
                      {step.status === "completed"
                        ? "✓"
                        : step.status === "in_progress"
                          ? "•"
                          : "○"}
                    </span>
                    <span
                      className={cn(
                        step.status === "completed" && "text-muted-foreground",
                        step.status === "in_progress" && "font-medium",
                      )}
                    >
                      {step.text}
                    </span>
                  </div>
                ))}
              </div>
            ) : plan.contentText.trim() ? (
              <div className="whitespace-pre-wrap text-sm leading-6">
                {plan.contentText}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {streaming ? "Waiting for plan content…" : "No plan content."}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (nested) {
    return content;
  }

  return (
    <TimelineRowShell
      active={streaming}
      label={timelineRowLabel(planTitle(plan), plan.status)}
    >
      {content}
    </TimelineRowShell>
  );
}

function DiffSummaryRow({
  diffId,
  nested = false,
}: {
  diffId: string;
  nested?: boolean;
}) {
  const diff = useChatStore((state) => selectChatDiffSummary(state, diffId));
  const conversation = useChatStore((state) =>
    diff ? selectChatConversation(state, diff.conversationId) : null,
  );
  const openGitDiff = useTabStore((state) => state.openGitDiff);
  if (!diff) {
    return null;
  }
  const files = diff.files.slice(0, 5);
  const handleOpenDiff = (path: string, originalPath?: string | null) => {
    if (!conversation) {
      return;
    }
    void openGitDiff({
      worktreeId: conversation.worktreeId,
      path,
      originalPath: originalPath ?? undefined,
      scope: "unstaged",
      preview: false,
    });
  };
  const content = (
    <div className={cn("w-full", !nested && "max-w-[min(46rem,92%)]")}>
      <div className="rounded-xl border bg-muted/25 px-3 py-3 text-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <GitCompare className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div>
              <div className="font-medium">Changes</div>
              <div className="text-xs text-muted-foreground">
                {diffStatsLabel(diff)}
              </div>
            </div>
            {files.length > 0 ? (
              <div className="space-y-1">
                {files.map((file) => (
                  <div
                    key={`${file.path}-${file.originalPath ?? ""}`}
                    className="flex items-center justify-between gap-3 rounded-md bg-background/60 px-2 py-1.5 text-xs"
                  >
                    <span className="min-w-0 truncate">{file.path}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      {file.additions != null || file.deletions != null ? (
                        <span className="text-muted-foreground">
                          {file.additions != null ? `+${file.additions}` : ""}
                          {file.deletions != null ? ` -${file.deletions}` : ""}
                        </span>
                      ) : null}
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!conversation}
                        onClick={() =>
                          handleOpenDiff(file.path, file.originalPath)
                        }
                      >
                        Open diff
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                Diff details are not available yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (nested) {
    return content;
  }

  return (
    <TimelineRowShell label={timelineRowLabel("Diff summary", "ready")}>
      {content}
    </TimelineRowShell>
  );
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function workGroupStatusLabel(active: boolean, status: string): string {
  if (active) {
    return "Working";
  }
  if (status === "completed") {
    return "Completed";
  }
  if (status === "failed") {
    return "Failed";
  }
  if (status === "interrupted") {
    return "Interrupted";
  }
  return status;
}

function reasoningPreview(message: ChatMessage | null): string | null {
  const text = message?.reasoningText.trim();
  if (!text) {
    return null;
  }
  return text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text;
}

function reasoningItemLabel(item: ChatItem | null): string {
  const metadata = itemMetadata(item);
  if (metadata.type === "agentMessage" && metadata.phase === "commentary") {
    return "Commentary";
  }
  return "Thinking";
}

function reasoningTextPreview(item: ChatItem | null): string | null {
  const text = item?.summary?.trim();
  if (!text) {
    return null;
  }
  return text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text;
}

function ReasoningItemBlock({
  conversationId,
  item,
  open,
}: {
  conversationId: string;
  item: ChatItem;
  open: boolean;
}) {
  const outputText = useChatStore((state) =>
    selectChatItemOutputIds(state, item.id)
      .map(
        (outputId) => selectChatItemOutput(state, outputId)?.contentText ?? "",
      )
      .join(""),
  );
  const ensureActivityLoaded = useChatStore(
    (state) => state.ensureActivityLoaded,
  );

  useEffect(() => {
    if (open) {
      void ensureActivityLoaded(conversationId, item.id);
    }
  }, [conversationId, ensureActivityLoaded, item.id, open]);

  const text = outputText.trim().length > 0 ? outputText : (item.summary ?? "");
  if (text.trim().length === 0) {
    return null;
  }

  return (
    <div
      className="rounded-lg border bg-background/55 px-3 py-3"
      aria-label={reasoningItemLabel(item)}
    >
      <div className="mb-2 text-xs font-medium text-foreground">
        {reasoningItemLabel(item)}
      </div>
      <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
        {text}
      </div>
    </div>
  );
}

function WorkGroupRow({
  conversationId,
  turnId,
  segmentKey,
}: {
  conversationId: string;
  turnId: string;
  segmentKey: string;
}) {
  const {
    active,
    activityIdsKey,
    diffSummaryIdsKey,
    pendingRequestIdsKey,
    planIdsKey,
    reasoningItem,
    reasoningMessage,
    status,
  } = useChatStore(
    useShallow((state) => {
      const slice = selectChatWorkGroupSlice(
        state,
        conversationId,
        turnId,
        segmentKey,
      );
      return {
        active: slice.active,
        activityIdsKey: slice.activityIds.join("\u0000"),
        diffSummaryIdsKey: slice.diffSummaryIds.join("\u0000"),
        pendingRequestIdsKey: slice.pendingRequestIds.join("\u0000"),
        planIdsKey: slice.planIds.join("\u0000"),
        reasoningItem: slice.reasoningItem,
        reasoningMessage: slice.reasoningMessage,
        status: slice.status,
      };
    }),
  );
  const [activeSnapshot, setActiveSnapshot] = useState(active);
  const [userOpen, setUserOpen] = useState<boolean | null>(
    active ? true : null,
  );
  if (active !== activeSnapshot) {
    setActiveSnapshot(active);
    if (active) {
      setUserOpen((current) => current ?? true);
    }
  }
  const activityIds = activityIdsKey ? activityIdsKey.split("\u0000") : [];
  const pendingRequestIds = pendingRequestIdsKey
    ? pendingRequestIdsKey.split("\u0000")
    : [];
  const planIds = planIdsKey ? planIdsKey.split("\u0000") : [];
  const diffSummaryIds = diffSummaryIdsKey
    ? diffSummaryIdsKey.split("\u0000")
    : [];

  const fallbackReasoningText =
    segmentKey === "initial"
      ? (reasoningMessage?.reasoningText.trim() ?? "")
      : "";
  const hasReasoning =
    Boolean(reasoningItem) || fallbackReasoningText.length > 0;
  const hasDetails =
    hasReasoning ||
    activityIds.length > 0 ||
    pendingRequestIds.length > 0 ||
    planIds.length > 0 ||
    diffSummaryIds.length > 0;

  if (!active && !hasDetails) {
    return null;
  }

  const open = active || userOpen === true;
  const statusLabel = workGroupStatusLabel(active, status);
  const counts = [
    activityIds.length > 0
      ? pluralize(activityIds.length, "activity", "activities")
      : null,
    pendingRequestIds.length > 0
      ? pluralize(pendingRequestIds.length, "request")
      : null,
    planIds.length > 0 ? pluralize(planIds.length, "plan") : null,
    diffSummaryIds.length > 0 ? pluralize(diffSummaryIds.length, "diff") : null,
  ].filter(Boolean);
  const summary =
    counts.length > 0 ? `${counts.join(" · ")} · ${statusLabel}` : statusLabel;
  const preview =
    reasoningTextPreview(reasoningItem) ?? reasoningPreview(reasoningMessage);
  const title = reasoningItem
    ? `Codex ${reasoningItemLabel(reasoningItem).toLowerCase()}`
    : "Codex worked for this turn";

  return (
    <TimelineRowShell
      active={active}
      label={timelineRowLabel("Codex work", statusLabel)}
    >
      <div className="w-full max-w-[min(46rem,92%)]">
        <Collapsible open={open} onOpenChange={setUserOpen}>
          <div className="rounded-xl border bg-muted/20 text-sm shadow-xs">
            <CollapsibleTrigger
              className="flex w-full items-start gap-3 px-3 py-3 text-left"
              aria-label={open ? "Collapse Codex work" : "Expand Codex work"}
            >
              <div
                className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
                  active && "text-primary",
                )}
              >
                {active ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wrench className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="font-medium">{title}</div>
                <div className="text-xs text-muted-foreground">{summary}</div>
                {preview && !open ? (
                  <div
                    className="mt-2 max-h-12 overflow-hidden whitespace-pre-wrap text-xs leading-5 text-muted-foreground"
                    data-testid="chat-work-reasoning-preview"
                  >
                    {preview}
                  </div>
                ) : null}
              </div>
              <ChevronDown
                className={cn(
                  "mt-1 h-4 w-4 text-muted-foreground transition-transform",
                  open && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-3 py-3">
              <div className="space-y-3">
                {reasoningItem ? (
                  <ReasoningItemBlock
                    conversationId={conversationId}
                    item={reasoningItem}
                    open={open}
                  />
                ) : fallbackReasoningText.length > 0 ? (
                  <div
                    className="rounded-lg border bg-background/55 px-3 py-3"
                    aria-label="Reasoning summary"
                  >
                    <div className="mb-2 text-xs font-medium text-foreground">
                      Thinking
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                      {fallbackReasoningText}
                    </div>
                  </div>
                ) : active ? (
                  <div className="rounded-lg border bg-background/55 px-3 py-3 text-xs text-muted-foreground">
                    Codex is preparing its next step…
                  </div>
                ) : null}
                {planIds.map((planId) => (
                  <PlanRow key={planId} planId={planId} nested />
                ))}
                {pendingRequestIds.map((requestId) => (
                  <NestedPendingRequestCard
                    key={requestId}
                    requestId={requestId}
                  />
                ))}
                {activityIds.map((itemId) => (
                  <ActivityRow
                    key={itemId}
                    conversationId={conversationId}
                    itemId={itemId}
                    nested
                  />
                ))}
                {diffSummaryIds.map((diffId) => (
                  <DiffSummaryRow key={diffId} diffId={diffId} nested />
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      </div>
    </TimelineRowShell>
  );
}

function ChatTimelineRow({
  conversationId,
  rowId,
}: {
  conversationId: string;
  rowId: string;
}) {
  if (rowId.startsWith("work:")) {
    const [, turnId, segmentKey = "initial"] = rowId.split(":");
    return (
      <WorkGroupRow
        conversationId={conversationId}
        turnId={turnId}
        segmentKey={segmentKey}
      />
    );
  }
  if (rowId.startsWith("message:user:")) {
    return <ChatMessageRow messageId={rowId.slice("message:user:".length)} />;
  }
  if (rowId.startsWith("message:assistant:")) {
    return (
      <ChatMessageRow messageId={rowId.slice("message:assistant:".length)} />
    );
  }
  if (rowId.startsWith("activity:")) {
    return (
      <ActivityRow
        conversationId={conversationId}
        itemId={rowId.slice("activity:".length)}
      />
    );
  }
  if (rowId.startsWith("request:")) {
    return <PendingRequestRow requestId={rowId.slice("request:".length)} />;
  }
  if (rowId.startsWith("plan:")) {
    return <PlanRow planId={rowId.slice("plan:".length)} />;
  }
  if (rowId.startsWith("diff:")) {
    return <DiffSummaryRow diffId={rowId.slice("diff:".length)} />;
  }
  if (rowId.startsWith("message:")) {
    return <ChatMessageRow messageId={rowId.slice("message:".length)} />;
  }
  return null;
}

export function ChatTranscript({ conversationId }: { conversationId: string }) {
  const timelineIds = useChatStore((state) =>
    selectChatTimelineIds(state, conversationId),
  );
  const detailLoaded = useChatStore(
    (state) => selectChatDetailState(state, conversationId).status === "loaded",
  );
  const { rootRef, contentRef } = useTimelineAutoFollow(timelineIds);

  return (
    <div
      ref={rootRef}
      className="min-h-0 flex-1"
      data-testid="chat-scroll-root"
    >
      <ScrollArea className="h-full">
        <div
          ref={contentRef}
          role="list"
          aria-label="Chat timeline"
          className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-4"
        >
          {!detailLoaded && timelineIds.length === 0 ? (
            <div className="flex min-h-[28vh] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              Loading chat history...
            </div>
          ) : timelineIds.length === 0 ? (
            <div className="flex min-h-[28vh] flex-col items-center justify-center px-6 text-center">
              <div className="rounded-full bg-primary/10 p-3 text-primary">
                <MessageSquareText className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-base font-medium">New Chat</h3>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Ask Codex about this worktree. History comes from Hubris state,
                while model and effort settings apply to future turns.
              </p>
            </div>
          ) : (
            timelineIds.map((rowId) => (
              <ChatTimelineRow
                key={rowId}
                conversationId={conversationId}
                rowId={rowId}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
