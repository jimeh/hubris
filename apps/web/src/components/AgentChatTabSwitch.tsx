import { lazy } from "react";
import { useChatSettings } from "@/lib/stores/chatSettings";
import type { AgentChatTab } from "@/lib/types";

// Both chat stacks are code-split so neither ships in the entry
// bundle: the classic (@assistant-ui) and CopilotKit (@copilotkit +
// @ag-ui) views are only fetched when a chat tab actually mounts, and
// only the stack selected by chat.uiStyle is loaded. Rendering
// suspends to the <Suspense> boundary at the mount point in
// WorktreeView.
const AgentChatTabClassicView = lazy(() => import("@/components/AgentChatTab"));
const CopilotKitAgentChatTabView = lazy(
  () => import("@/components/CopilotKitAgentChatTab"),
);

type Props = {
  tab: AgentChatTab;
  visible: boolean;
};

/**
 * Chat tab entry point that dispatches to the chat UI selected by the
 * `chat.uiStyle` setting, lazy-loading only that stack's bundle.
 */
export default function AgentChatTabSwitch(props: Props) {
  const uiStyle = useChatSettings((state) => state.settings.uiStyle);
  if (uiStyle === "copilotkit") {
    return <CopilotKitAgentChatTabView {...props} />;
  }
  return <AgentChatTabClassicView {...props} />;
}
