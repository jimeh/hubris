import type { ChatPendingRequest } from "@/lib/types";

/** Returns the shared user-facing label for a pending request kind. */
export function requestKindLabel(request: ChatPendingRequest): string {
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
