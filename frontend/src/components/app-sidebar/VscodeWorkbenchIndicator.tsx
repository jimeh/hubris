import { Code } from "lucide-react";
import { useVscodeWorkbenchStore } from "@/lib/stores/vscodeWorkbench";

type Props = {
  worktreeId: string;
};

/** Shows whether this worktree has a retained VS Code workbench. */
export default function VscodeWorkbenchIndicator({ worktreeId }: Props) {
  const loaded = useVscodeWorkbenchStore((state) =>
    state.loadedWorktreeIds.includes(worktreeId),
  );

  if (!loaded) return null;

  return (
    <Code
      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
      aria-label="VS Code workbench loaded"
    />
  );
}
