import { useMemo } from "react";
import type { Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
  active: boolean;
};

/** Hosts a persistent VS Code workbench iframe for one worktree. */
export default function VscodeWorkbenchPane({ worktree, active }: Props) {
  const src = useMemo(() => {
    const params = new URLSearchParams({ folder: worktree.path });
    return `/code/?${params.toString()}`;
  }, [worktree.path]);

  return (
    <div
      className={cn(
        "absolute inset-0 flex overflow-hidden",
        active ? "visible" : "invisible pointer-events-none",
      )}
      aria-hidden={active ? "false" : "true"}
      data-vscode-workbench-pane={worktree.id}
      data-state={active ? "active" : "inactive"}
    >
      <iframe
        title={`VS Code workbench for ${worktree.name}`}
        src={src}
        className="h-full w-full border-0 bg-background"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
