import { selectTabsForWorktree, useTabStore } from "@/lib/stores/tabs";

type Props = {
  worktreeId: string;
};

/**
 * Shows a notification dot when any terminal tab in this
 * worktree has a pending notification.
 */
export default function WorktreeIndicator({ worktreeId }: Props) {
  const hasNotification = useTabStore((state) =>
    selectTabsForWorktree(state, worktreeId).some(
      (tab) =>
        tab.worktree_id === worktreeId &&
        tab.type === "terminal" &&
        !!tab.has_notification,
    ),
  );

  return (
    <span
      className="inline-flex size-3.5 shrink-0 items-center justify-center"
      aria-label={hasNotification ? "Terminal notification" : undefined}
    >
      {hasNotification ? (
        <span
          className="size-2 rounded-full bg-notification-dot"
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}
