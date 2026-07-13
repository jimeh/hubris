import { lazy } from "react";
import { useChatSettings } from "@/lib/stores/chatSettings";
// Type-only import: erased at compile time, so it does not undo the
// code-splitting of the lazy() imports below.
import type { AgentChatTabProps } from "@/features/chat/classic/AgentChatTabClassicView";

// Both chat stacks are code-split so neither ships in the entry
// bundle: the classic (@assistant-ui) and CopilotKit (@copilotkit +
// @ag-ui) views are only fetched when a chat tab actually mounts, and
// only the stack selected by chat.uiStyle is loaded. Rendering
// suspends to the <Suspense> boundary at the mount point in
// WorktreeView.
const AgentChatTabClassicView = lazy(
  () => import("@/features/chat/classic/AgentChatTabClassicView"),
);
const CopilotKitAgentChatTabView = lazy(
  () => import("@/features/chat/CopilotKitAgentChatTab"),
);

/**
 * Chat tab entry point that dispatches to the chat UI selected by the
 * `chat.uiStyle` setting, lazy-loading only that stack's bundle.
 */
export default function AgentChatTabSwitch(props: AgentChatTabProps) {
  const uiStyle = useChatSettings((state) => state.settings.uiStyle);
  if (uiStyle === "copilotkit") {
    return <CopilotKitAgentChatTabView {...props} />;
  }
  return <AgentChatTabClassicView {...props} />;
}
