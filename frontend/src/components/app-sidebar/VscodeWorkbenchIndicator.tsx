import { useVscodeWorkbenchStore } from "@/lib/stores/vscodeWorkbench";

type Props = {
  worktreeId: string;
};

/** Shows whether this worktree has a retained VS Code workbench. */
export default function VscodeWorkbenchIndicator({ worktreeId }: Props) {
  const loaded = useVscodeWorkbenchStore((state) =>
    state.loadedWorktreeIds.includes(worktreeId),
  );

  return (
    <span
      className="inline-flex size-3.5 shrink-0 items-center justify-center"
      aria-label={loaded ? "VS Code workbench loaded" : undefined}
    >
      {loaded ? (
        <span className="size-2 rounded-full bg-sky-500" aria-hidden="true" />
      ) : null}
    </span>
  );
}
