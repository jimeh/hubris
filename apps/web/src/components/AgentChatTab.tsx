import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ChevronDown,
  ClipboardList,
  FilePenLine,
  GitCompare,
  LoaderCircle,
  MessageSquareText,
  SendHorizontal,
  ShieldAlert,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
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
  activityLabel,
  activityStatusLabel,
  isRuntimeRunning,
  itemMetadata,
} from "@/lib/chat/";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  selectChatComposerMessages,
  selectChatActivityDetailState,
  selectChatConversation,
  selectChatContextUsage,
  selectChatDiffSummary,
  selectChatDetailState,
  selectChatHeaderSlice,
  selectChatItem,
  selectChatItemOutput,
  selectChatItemOutputIds,
  selectChatMessage,
  selectChatModelSlice,
  selectChatReconciliation,
  selectChatActivePendingRequestIds,
  selectChatPendingRequest,
  selectChatPlan,
  selectChatTimelineIds,
  selectChatWorkGroupSlice,
  useChatStore,
} from "@/lib/stores/chats";
import { useChatSettings } from "@/lib/stores/chatSettings";
import { useTabStore } from "@/lib/stores/tabs";
import type {
  AgentChatTab,
  ChatContextUsage,
  ChatDiffSummary,
  ChatItem,
  ChatMessage,
  ChatModelOption,
  ChatPendingRequest,
  ChatPendingRequestDecision,
  ChatPlan,
  ChatPermissionMode,
  ChatReconciliation,
  ChatReasoningEffort,
  ChatRuntimeLifecycle,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export type AgentChatTabProps = {
  tab: AgentChatTab;
  visible: boolean;
};

const AUTO_FOLLOW_THRESHOLD_PX = 96;

const CONTAINED_TIMELINE_ROW_STYLE: CSSProperties = {
  contain: "layout style paint",
  containIntrinsicSize: "0 10rem",
  contentVisibility: "auto",
};

const convertThreadMessage = (message: ThreadMessageLike) => message;

function runtimeStatusLabel(
  lifecycle: ChatRuntimeLifecycle | undefined,
): string {
  switch (lifecycle) {
    case "starting":
      return "Starting Codex";
    case "ready":
      return "Warm";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "failed":
      return "Runtime failed";
    default:
      return "Idle";
  }
}

function reconciliationStatusText(
  reconciliation: ChatReconciliation | null,
): string | null {
  switch (reconciliation?.status) {
    case "pending":
      return "Codex disconnected before this turn completed. Hubris will reconcile the transcript when the thread resumes.";
    case "running":
      return "Reconciling Codex thread state. Existing transcript remains visible while Hubris verifies provider state.";
    case "failed":
      return reconciliation.errorMessage
        ? `Reconciliation failed: ${reconciliation.errorMessage}`
        : "Reconciliation failed. Partial transcript was preserved and future sends are allowed.";
    default:
      return null;
  }
}

function effortLabel(value: ChatReasoningEffort): string {
  switch (value) {
    case "none":
      return "None";
    case "minimal":
      return "Minimal";
    case "low":
      return "Low";
    case "medium":
      return "Medium";
    case "high":
      return "High";
    case "xhigh":
      return "XHigh";
  }
}

function permissionLabel(value: ChatPermissionMode | "default"): string {
  switch (value) {
    case "full_access":
      return "Full access";
    default:
      return "Default permissions";
  }
}

function resolveSelectedModel(
  models: readonly ChatModelOption[],
  selectedModel: string | null | undefined,
): ChatModelOption | undefined {
  if (selectedModel) {
    return models.find((model) => model.model === selectedModel);
  }
  return models.find((model) => model.isDefault) ?? models[0];
}

function resolveSelectedEffort(
  model: ChatModelOption | undefined,
  selectedEffort: ChatReasoningEffort | null | undefined,
): ChatReasoningEffort | undefined {
  if (selectedEffort) {
    return selectedEffort;
  }
  return model?.defaultReasoningEffort;
}

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

function requestKindLabel(request: ChatPendingRequest): string {
  switch (request.kind) {
    case "command_approval":
      return "Command approval";
    case "file_approval":
      return "File approval";
    case "permission_approval":
      return "Permission request";
    case "structured_input":
      return "Codex question";
    case "mcp_elicitation":
      return "Tool input";
    default:
      return "Unsupported request";
  }
}

function requestStatusLabel(request: ChatPendingRequest): string {
  switch (request.status) {
    case "pending":
      return "Waiting for response";
    case "resolving":
      return "Resolving";
    case "resolved":
      return "Resolved";
    case "declined":
      return "Declined";
    case "cancelled":
      return "Cancelled";
    case "stale":
      return "No longer answerable";
    case "failed":
      return "Resolution failed";
  }
}

function requestPayload(request: ChatPendingRequest): Record<string, unknown> {
  try {
    const parsed = JSON.parse(request.payloadJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(" ");
  }
  if (value == null) {
    return "";
  }
  return JSON.stringify(value, null, 2);
}

function advertisedDecisions(
  payload: Record<string, unknown>,
): ChatPendingRequestDecision[] {
  const decisions = payload.availableDecisions;
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return ["accept", "decline", "cancel"];
  }
  return decisions
    .map((decision) => {
      if (typeof decision === "string") {
        return decision as ChatPendingRequestDecision;
      }
      if (decision && typeof decision === "object") {
        if ("acceptWithExecpolicyAmendment" in decision) {
          return "acceptWithExecpolicyAmendment";
        }
        if ("applyNetworkPolicyAmendment" in decision) {
          return "applyNetworkPolicyAmendment";
        }
      }
      return null;
    })
    .filter((decision): decision is ChatPendingRequestDecision =>
      Boolean(decision),
    );
}

function simpleOptions(payload: Record<string, unknown>): string[] {
  const questions = payload.questions;
  if (!Array.isArray(questions) || questions.length !== 1) {
    return [];
  }
  const question = questions[0];
  if (!question || typeof question !== "object") {
    return [];
  }
  const options = (question as { options?: unknown }).options;
  if (!Array.isArray(options) || options.length > 3) {
    return [];
  }
  return options
    .map((option) =>
      typeof option === "string"
        ? option
        : typeof option === "object" && option !== null && "label" in option
          ? String((option as { label: unknown }).label)
          : "",
    )
    .filter(Boolean);
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

function contextUsageLabel(usage: ChatContextUsage | null): string {
  if (!usage) {
    return "Context";
  }
  if (typeof usage.percentUsed === "number") {
    return `${Math.round(usage.percentUsed)}% context`;
  }
  if (usage.usedTokens != null && usage.maxTokens != null) {
    return `${usage.usedTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()}`;
  }
  return "Context";
}

function contextUsageTitle(usage: ChatContextUsage | null): string {
  if (!usage) {
    return "Context usage has not been reported for this chat yet.";
  }
  const lines = [];
  if (usage.usedTokens != null || usage.maxTokens != null) {
    lines.push(
      `Used: ${usage.usedTokens?.toLocaleString() ?? "unknown"} / ${
        usage.maxTokens?.toLocaleString() ?? "unknown"
      } tokens`,
    );
  }
  if (usage.totalProcessedTokens != null) {
    lines.push(
      `Processed: ${usage.totalProcessedTokens.toLocaleString()} tokens`,
    );
  }
  if (usage.percentUsed != null) {
    lines.push(`Context: ${Math.round(usage.percentUsed)}%`);
  }
  return lines.join("\n") || "Context usage has been updated.";
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

function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(
      target.closest(
        'button, input, textarea, select, [contenteditable="true"], [role="textbox"], [data-chat-ignore-shortcuts="true"]',
      ),
    )
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

function ChatHeader({
  conversationId,
  label,
}: {
  conversationId: string;
  label: string;
}) {
  const updateChatSettings = useChatSettings((state) => state.updateSettings);
  const {
    conversation,
    detailError,
    hasStreamingMessage,
    latestRun,
    modelOptionsError,
    runtime,
  } = useChatStore(
    useShallow((state) => selectChatHeaderSlice(state, conversationId)),
  );
  const isRunning = isRuntimeRunning(runtime?.lifecycle);
  const isRunActive = isRunning || hasStreamingMessage;
  const runtimeLabel = runtimeStatusLabel(runtime?.lifecycle);
  const latestError =
    runtime?.lastError ??
    latestRun?.errorMessage ??
    conversation?.lastError ??
    detailError ??
    modelOptionsError;

  return (
    <div
      className="flex items-center justify-between gap-3 border-b px-4 py-3"
      aria-label="Chat header"
    >
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div
          className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {isRunActive ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : null}
          <span>{runtimeLabel}</span>
        </div>
      </div>
      {latestError ? (
        <div className="max-w-xs truncate text-xs text-destructive">
          {latestError}
        </div>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => updateChatSettings({ uiStyle: "copilotkit" })}
      >
        CopilotKit
      </Button>
    </div>
  );
}

function ReconciliationBanner({ conversationId }: { conversationId: string }) {
  const reconciliation = useChatStore((state) =>
    selectChatReconciliation(state, conversationId),
  );
  const text = reconciliationStatusText(reconciliation);
  if (!text) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-b bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
    >
      <div className="mx-auto max-w-3xl">{text}</div>
    </div>
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

function PendingRequestActions({
  request,
  compact = false,
}: {
  request: ChatPendingRequest;
  compact?: boolean;
}) {
  const payload = requestPayload(request);
  const resolvePendingRequest = useChatStore(
    (state) => state.resolvePendingRequest,
  );
  const [answer, setAnswer] = useState("");
  const disabled = request.status !== "pending";
  const resolving = request.status === "resolving";
  const decisions = advertisedDecisions(payload);
  const options = simpleOptions(payload);

  const resolve = async (
    decision: ChatPendingRequestDecision,
    value?: unknown,
  ) => {
    await resolvePendingRequest(
      request.conversationId,
      request.id,
      decision,
      value,
    );
  };

  if (
    request.kind === "structured_input" ||
    request.kind === "mcp_elicitation"
  ) {
    return (
      <div className="space-y-2">
        {options.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {options.map((option) => (
              <Button
                key={option}
                size="xs"
                disabled={disabled}
                data-chat-pending-action="primary"
                onClick={() => resolve("submit", { answers: [option] })}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus-visible:border-ring"
              value={answer}
              disabled={disabled}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="Answer Codex"
              aria-label="Answer Codex"
            />
            <Button
              size="xs"
              disabled={disabled || answer.trim().length === 0}
              data-chat-pending-action="primary"
              onClick={() => resolve("submit", { answer: answer.trim() })}
            >
              Submit
            </Button>
          </div>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => resolve("decline")}
        >
          Decline
        </Button>
      </div>
    );
  }

  if (request.status !== "pending" && request.status !== "resolving") {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap gap-2", compact && "gap-1.5")}>
      {decisions.includes("accept") ? (
        <Button
          size="xs"
          disabled={disabled}
          data-chat-pending-action="primary"
          onClick={() => resolve("accept")}
        >
          Allow
        </Button>
      ) : null}
      {decisions.includes("acceptForSession") ? (
        <Button
          size="xs"
          variant="secondary"
          disabled={disabled}
          onClick={() => resolve("acceptForSession")}
        >
          Allow for session
        </Button>
      ) : null}
      {decisions.includes("acceptWithExecpolicyAmendment") ? (
        <Button
          size="xs"
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            resolve(
              "acceptWithExecpolicyAmendment",
              payload.proposedExecpolicyAmendment,
            )
          }
        >
          Allow with policy
        </Button>
      ) : null}
      {decisions.includes("applyNetworkPolicyAmendment") ? (
        <Button
          size="xs"
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            resolve(
              "applyNetworkPolicyAmendment",
              payload.proposedNetworkPolicyAmendment,
            )
          }
        >
          Allow network
        </Button>
      ) : null}
      {decisions.includes("decline") ? (
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => resolve("decline")}
        >
          Deny
        </Button>
      ) : null}
      {decisions.includes("cancel") ? (
        <Button
          size="xs"
          variant="destructive"
          disabled={disabled}
          onClick={() => resolve("cancel")}
        >
          Cancel turn
        </Button>
      ) : null}
      {resolving ? (
        <span
          className="self-center text-xs text-muted-foreground"
          aria-live="polite"
        >
          Resolving…
        </span>
      ) : null}
    </div>
  );
}

function PendingRequestCard({
  request,
  compact = false,
}: {
  request: ChatPendingRequest;
  compact?: boolean;
}) {
  const payload = requestPayload(request);
  const command = formatUnknown(payload.command);
  const cwd = formatUnknown(payload.cwd);
  const reason = formatUnknown(payload.reason);
  const grantRoot = formatUnknown(payload.grantRoot);
  const statusTerminal =
    request.status !== "pending" && request.status !== "resolving";

  return (
    <div
      role="group"
      aria-label={requestKindLabel(request)}
      className={cn(
        "rounded-xl border bg-card px-3 py-3 text-sm shadow-xs",
        request.status === "stale" && "border-muted-foreground/30",
        request.status === "failed" && "border-destructive/40",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          {request.status === "resolving" ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <div className="font-medium">{requestKindLabel(request)}</div>
            <div className="text-xs text-muted-foreground">
              {requestStatusLabel(request)}
            </div>
          </div>
          {request.status === "stale" ? (
            <div className="rounded-md bg-muted/45 px-2 py-1.5 text-xs text-muted-foreground">
              This request can no longer be answered because the Codex stream or
              turn changed.
            </div>
          ) : null}
          {reason ? (
            <div className="text-xs text-muted-foreground">{reason}</div>
          ) : null}
          {command && !compact ? (
            <pre className="max-h-32 overflow-auto rounded-md bg-muted/45 p-2 text-xs">
              {command}
            </pre>
          ) : null}
          {cwd || grantRoot ? (
            <div className="space-y-1 text-xs text-muted-foreground">
              {cwd ? <div>CWD: {cwd}</div> : null}
              {grantRoot ? <div>Root: {grantRoot}</div> : null}
            </div>
          ) : null}
          {!statusTerminal ? (
            <PendingRequestActions request={request} compact={compact} />
          ) : null}
          {request.errorMessage ? (
            <div className="text-xs text-destructive">
              {request.errorMessage}
            </div>
          ) : null}
        </div>
      </div>
    </div>
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

function ChatTranscript({ conversationId }: { conversationId: string }) {
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

function PendingRequestPanel({ conversationId }: { conversationId: string }) {
  const requestIds = useChatStore(
    useShallow((state) =>
      selectChatActivePendingRequestIds(state, conversationId),
    ),
  );

  if (requestIds.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        Codex is waiting for approval or input. You can draft a follow-up, but
        sending is paused until this is answered.
      </div>
      {requestIds.map((requestId) => (
        <PendingRequestPanelCard key={requestId} requestId={requestId} />
      ))}
    </div>
  );
}

function PendingRequestPanelCard({ requestId }: { requestId: string }) {
  const request = useChatStore((state) =>
    selectChatPendingRequest(state, requestId),
  );
  if (!request) {
    return null;
  }
  return (
    <div data-chat-pending-request-panel="true">
      <PendingRequestCard request={request} compact />
    </div>
  );
}

function ContextUsageMeter({ conversationId }: { conversationId: string }) {
  const usage = useChatStore((state) =>
    selectChatContextUsage(state, conversationId),
  );
  const percent =
    typeof usage?.percentUsed === "number"
      ? Math.max(0, Math.min(100, usage.percentUsed))
      : null;
  return (
    <div
      role="meter"
      aria-label={contextUsageTitle(usage)}
      aria-valuemin={percent != null ? 0 : undefined}
      aria-valuemax={percent != null ? 100 : undefined}
      aria-valuenow={percent != null ? Math.round(percent) : undefined}
      className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-2 text-xs text-muted-foreground"
      title={contextUsageTitle(usage)}
    >
      <span>{contextUsageLabel(usage)}</span>
      {percent != null ? (
        <span className="h-1.5 w-14 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full bg-primary",
              percent >= 85 && "bg-amber-500",
              percent >= 95 && "bg-destructive",
            )}
            style={{ width: `${percent}%` }}
          />
        </span>
      ) : null}
    </div>
  );
}

function ChatComposer({
  conversationId,
  worktreeId,
}: {
  conversationId: string;
  worktreeId: string;
}) {
  const {
    conversation,
    hasStreamingMessage,
    modelOptions,
    modelOptionsStatus,
    reconciliation,
    runtime: runtimeStatus,
  } = useChatStore(
    useShallow((state) => selectChatModelSlice(state, conversationId)),
  );
  const isRunning = isRuntimeRunning(runtimeStatus?.lifecycle);
  const isRunActive = isRunning || hasStreamingMessage;
  const isReconciling = reconciliation?.status === "running";
  const isArchived = conversation?.archivedAt != null;
  const activePendingRequestIds = useChatStore(
    useShallow((state) =>
      selectChatActivePendingRequestIds(state, conversationId),
    ),
  );
  const hasBlockingRequest = activePendingRequestIds.length > 0;
  const runtimeMessages = selectChatComposerMessages();
  const sendMessage = useChatStore((state) => state.sendMessage);
  const interruptRun = useChatStore((state) => state.interruptRun);
  const updateConversationSettings = useChatStore(
    (state) => state.updateConversationSettings,
  );

  const selectedModel = useMemo(
    () => resolveSelectedModel(modelOptions, conversation?.selectedModel),
    [conversation?.selectedModel, modelOptions],
  );
  const selectedEffort = resolveSelectedEffort(
    selectedModel,
    conversation?.selectedEffort,
  );
  const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const selectedPermissionMode =
    conversation?.selectedPermissionMode ?? "default";

  const runtime = useExternalStoreRuntime({
    isRunning,
    messages: runtimeMessages,
    convertMessage: convertThreadMessage,
    onNew: async (message: AppendMessage) => {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      if (!text) {
        return;
      }
      if (hasBlockingRequest || isReconciling || isArchived) {
        return;
      }
      await sendMessage(conversationId, text, worktreeId);
    },
    onCancel: async () => {
      await interruptRun(conversationId);
    },
  });

  const handleModelChange = async (modelValue: string) => {
    const nextModel = modelOptions.find(
      (option) => option.model === modelValue,
    );
    await updateConversationSettings(conversationId, {
      selectedModel: modelValue,
      selectedEffort:
        nextModel?.supportedReasoningEfforts.find(
          (option) => option.reasoningEffort === selectedEffort,
        )?.reasoningEffort ??
        nextModel?.defaultReasoningEffort ??
        null,
      selectedPermissionMode: conversation?.selectedPermissionMode ?? null,
    });
  };

  const handleEffortChange = async (effort: string) => {
    await updateConversationSettings(conversationId, {
      selectedModel: selectedModel?.model ?? null,
      selectedEffort: effort as ChatReasoningEffort,
      selectedPermissionMode: conversation?.selectedPermissionMode ?? null,
    });
  };

  const handlePermissionChange = async (permissionMode: string) => {
    await updateConversationSettings(conversationId, {
      selectedModel: selectedModel?.model ?? null,
      selectedEffort: selectedEffort ?? null,
      selectedPermissionMode:
        permissionMode === "default"
          ? null
          : (permissionMode as ChatPermissionMode),
    });
  };
  const sendDisabledReason = hasBlockingRequest
    ? "Codex is waiting for approval or input."
    : isReconciling
      ? "Hubris is reconciling Codex thread state."
      : isArchived
        ? "Unarchive this chat to continue."
        : undefined;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          {isArchived ? (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              This chat is archived. Unarchive it from the Chats panel to
              continue.
            </div>
          ) : null}
          <PendingRequestPanel conversationId={conversationId} />
          <ComposerPrimitive.Root className="flex flex-col gap-3">
            <ComposerPrimitive.Input
              aria-label="Message Codex"
              data-chat-composer-input="true"
              className="min-h-14 max-h-40 w-full resize-none rounded-xl border bg-card px-3 py-2 text-sm outline-none ring-0 placeholder:text-muted-foreground focus-visible:border-ring"
              disabled={isArchived}
              placeholder={
                isArchived
                  ? "Unarchive this chat to continue"
                  : "Ask Codex about this worktree"
              }
              submitMode="enter"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  disabled={isArchived}
                  value={selectedPermissionMode}
                  onValueChange={handlePermissionChange}
                >
                  <SelectTrigger
                    size="sm"
                    className="bg-card"
                    aria-label="Codex permissions"
                  >
                    <SelectValue placeholder="Permissions">
                      {permissionLabel(selectedPermissionMode)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start">
                    <SelectItem value="default">Default permissions</SelectItem>
                    <SelectItem value="full_access">Full access</SelectItem>
                  </SelectContent>
                </Select>

                <Select
                  disabled={isArchived || modelOptionsStatus !== "loaded"}
                  value={selectedModel?.model}
                  onValueChange={handleModelChange}
                >
                  <SelectTrigger
                    size="sm"
                    className="bg-card"
                    aria-label="Codex model"
                  >
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {modelOptions.map((model) => (
                      <SelectItem key={model.id} value={model.model}>
                        {model.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  disabled={
                    isArchived ||
                    !selectedModel ||
                    supportedEfforts.length === 0
                  }
                  value={selectedEffort}
                  onValueChange={handleEffortChange}
                >
                  <SelectTrigger
                    size="sm"
                    className="bg-card"
                    aria-label="Codex reasoning effort"
                  >
                    <SelectValue placeholder="Effort" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {supportedEfforts.map((option) => (
                      <SelectItem
                        key={option.reasoningEffort}
                        value={option.reasoningEffort}
                      >
                        {effortLabel(option.reasoningEffort)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <ContextUsageMeter conversationId={conversationId} />
              </div>

              <div className="flex items-center">
                {isRunActive ? (
                  <ComposerPrimitive.Cancel
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted"
                    aria-label="Interrupt run"
                    title="Interrupt run"
                  >
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </ComposerPrimitive.Cancel>
                ) : (
                  <ComposerPrimitive.Send
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    disabled={hasBlockingRequest || isReconciling || isArchived}
                    aria-disabled={
                      hasBlockingRequest || isReconciling || isArchived
                    }
                    aria-label="Send message"
                    title={sendDisabledReason ?? "Send message"}
                  >
                    <SendHorizontal className="h-4 w-4" />
                  </ComposerPrimitive.Send>
                )}
              </div>
            </div>
          </ComposerPrimitive.Root>
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}

export function AgentChatTabClassicView({ tab, visible }: AgentChatTabProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const detailState = useChatStore((state) =>
    selectChatDetailState(state, tab.conversation_id),
  );
  const { hasBlockingRequest, isRunActive } = useChatStore(
    useShallow((state) => {
      const header = selectChatHeaderSlice(state, tab.conversation_id);
      return {
        hasBlockingRequest:
          selectChatActivePendingRequestIds(state, tab.conversation_id).length >
          0,
        isRunActive:
          isRuntimeRunning(header.runtime?.lifecycle) ||
          header.hasStreamingMessage,
      };
    }),
  );
  const ensureConversationLoaded = useChatStore(
    (state) => state.ensureConversationLoaded,
  );
  const ensureModelsLoaded = useChatStore((state) => state.ensureModelsLoaded);
  const refreshConversation = useChatStore(
    (state) => state.refreshConversation,
  );
  const interruptRun = useChatStore((state) => state.interruptRun);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) {
      return;
    }
    if (event.key === "/" && !isInteractiveShortcutTarget(event.target)) {
      event.preventDefault();
      rootRef.current
        ?.querySelector<HTMLElement>('[data-chat-composer-input="true"]')
        ?.focus();
      return;
    }
    if (event.key === "Escape" && isRunActive) {
      event.preventDefault();
      void interruptRun(tab.conversation_id);
      return;
    }
    if (event.altKey && event.key.toLowerCase() === "a" && hasBlockingRequest) {
      event.preventDefault();
      rootRef.current
        ?.querySelector<HTMLElement>(
          '[data-chat-pending-request-panel="true"] [data-chat-pending-action="primary"]',
        )
        ?.focus();
    }
  };

  useEffect(() => {
    if (!visible) {
      return;
    }
    void ensureConversationLoaded(tab.conversation_id);
    void ensureModelsLoaded();
  }, [
    ensureConversationLoaded,
    ensureModelsLoaded,
    tab.conversation_id,
    visible,
  ]);

  useEffect(() => {
    if (!visible || !detailState.needsRefresh) {
      return;
    }
    void refreshConversation(tab.conversation_id);
  }, [
    detailState.needsRefresh,
    refreshConversation,
    tab.conversation_id,
    visible,
  ]);

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-col bg-background"
      data-testid="agent-chat-tab"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      aria-label="Codex chat tab"
    >
      <ChatHeader conversationId={tab.conversation_id} label={tab.label} />
      <ReconciliationBanner conversationId={tab.conversation_id} />
      <ChatTranscript conversationId={tab.conversation_id} />
      <ChatComposer
        conversationId={tab.conversation_id}
        worktreeId={tab.worktree_id}
      />
    </div>
  );
}

// The uiStyle dispatch between the classic and CopilotKit views lives
// in AgentChatTabSwitch so this module (and its @assistant-ui
// dependency) never loads when CopilotKit chat is selected, and vice
// versa.
export default AgentChatTabClassicView;
