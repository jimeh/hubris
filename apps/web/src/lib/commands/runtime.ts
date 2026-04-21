import { toast } from "sonner";
import { getCommandContextSnapshot } from "./context";
import { getCommandDefinition } from "./registry";
import type {
  CommandArgsById,
  CommandAvailability,
  CommandId,
  CommandResult,
  CommandSource,
} from "./types";

type ExecuteCommandInput<TId extends CommandId> = {
  args?: CommandArgsById[TId];
  id: TId;
  source: CommandSource;
};

export function getCommandAvailability<TId extends CommandId>(
  id: TId,
  args?: CommandArgsById[TId],
): CommandAvailability {
  const context = getCommandContextSnapshot();
  return getCommandDefinition(id).isAvailable(context, args);
}

export async function executeCommand<TId extends CommandId>({
  args,
  id,
  source,
}: ExecuteCommandInput<TId>): Promise<CommandResult> {
  const context = getCommandContextSnapshot();
  const definition = getCommandDefinition(id);
  const availability = definition.isAvailable(context, args);
  if (!availability.enabled) {
    return { reason: availability.reason, status: "unavailable" };
  }

  try {
    const result = await definition.execute(context, args, source);
    if (result.status === "error") {
      toast.error(definition.title, {
        description: result.message,
      });
    }
    return result;
  } catch (error) {
    const message = (error as Error).message || "Unknown error";
    toast.error(definition.title, { description: message });
    return { message, status: "error" };
  }
}
