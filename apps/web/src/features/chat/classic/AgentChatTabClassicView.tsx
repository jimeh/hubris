// Frozen classic renderer: no new investment; CopilotKit is the promoted default.

import { type KeyboardEvent, useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChatComposer } from "@/features/chat/classic/ChatComposer";
import {
  ChatHeader,
  ReconciliationBanner,
} from "@/features/chat/classic/ChatHeader";
import { ChatTranscript } from "@/features/chat/classic/ChatTimeline";
import { isRuntimeRunning } from "@/lib/chat/";
import {
  selectChatActivePendingRequestIds,
  selectChatDetailState,
  selectChatHeaderSlice,
  useChatStore,
} from "@/lib/stores/chats";
import type { AgentChatTab } from "@/lib/types";

export type AgentChatTabProps = {
  tab: AgentChatTab;
  visible: boolean;
};

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
