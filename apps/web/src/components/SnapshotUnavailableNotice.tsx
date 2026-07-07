import { CloudOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { retrySnapshot, useConnectionStore } from "@/lib/stores/connection";

/**
 * Full-width banner shown when the server sent `snapshot_unavailable`
 * instead of the initial SSE snapshot. Without it the app would sit on
 * empty stores with no indication anything went wrong.
 */
export default function SnapshotUnavailableNotice() {
  const error = useConnectionStore((state) => state.snapshotError);

  if (!error) {
    return null;
  }

  return (
    <section
      aria-atomic="true"
      aria-live="assertive"
      role="alert"
      className="relative overflow-hidden border border-x-0 border-t-0 border-red-500/40 bg-[linear-gradient(135deg,rgba(239,68,68,0.16),rgba(248,113,113,0.08)_46%,rgba(127,29,29,0.14))] text-red-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] dark:text-red-50"
    >
      <div className="absolute inset-y-0 left-0 w-1 bg-red-500/70" />
      <div className="relative flex gap-3 px-4 py-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-500/18 ring-1 ring-inset ring-red-600/30">
          <CloudOff className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold tracking-[0.01em]">
              Server state could not be loaded
            </p>
            <span className="rounded-full border border-red-700/20 bg-red-50/70 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.18em] text-red-900/80 dark:bg-red-200/10 dark:text-red-100/80">
              {error.scope}
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-5 text-red-950/88 dark:text-red-50/88">
            The server failed to build its state snapshot, so projects, tabs,
            and chats may be missing or stale.
          </p>
          <p className="font-mono text-[12px] leading-5 text-red-900/80 dark:text-red-100/80">
            {error.message}
          </p>
        </div>
        <div className="flex items-start">
          <Button
            size="sm"
            variant="outline"
            className="border-red-600/40 bg-transparent text-red-950 hover:bg-red-500/10 dark:text-red-50"
            onClick={retrySnapshot}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </div>
    </section>
  );
}
