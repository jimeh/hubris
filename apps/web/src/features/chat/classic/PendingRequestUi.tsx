// Frozen classic renderer: no new investment; CopilotKit is the promoted default.

import { LoaderCircle, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { requestKindLabel } from "@/features/chat/classic/pendingRequestLabels";
import {
  selectChatActivePendingRequestIds,
  selectChatPendingRequest,
  useChatStore,
} from "@/lib/stores/chats";
import type {
  ChatPendingRequest,
  ChatPendingRequestDecision,
} from "@/lib/types";
import { cn } from "@/lib/utils";

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
    try {
      await resolvePendingRequest(
        request.conversationId,
        request.id,
        decision,
        value,
      );
    } catch (error) {
      console.warn("Failed to resolve pending chat request", error);
    }
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

export function PendingRequestCard({
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

export function PendingRequestPanel({
  conversationId,
}: {
  conversationId: string;
}) {
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
