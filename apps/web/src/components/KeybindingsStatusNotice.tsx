import { AlertTriangle } from "lucide-react";
import type { KeybindingsStatus } from "@/lib/contracts/sse.generated";

export default function KeybindingsStatusNotice({
  status,
}: {
  status: KeybindingsStatus;
}) {
  if (status.kind !== "invalidFile") {
    return null;
  }

  return (
    <section
      aria-live="polite"
      className="relative overflow-hidden border border-x-0 border-t-0 border-amber-500/40 bg-[linear-gradient(135deg,rgba(245,158,11,0.16),rgba(251,191,36,0.08)_46%,rgba(120,53,15,0.14))] text-amber-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)] dark:text-amber-50"
    >
      <div className="absolute inset-y-0 left-0 w-1 bg-amber-500/70" />
      <div className="relative flex gap-3 px-4 py-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500/18 ring-1 ring-inset ring-amber-600/30">
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold tracking-[0.01em]">
              Keybindings file is invalid
            </p>
            <span className="rounded-full border border-amber-700/20 bg-amber-50/70 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.18em] text-amber-900/80 dark:bg-amber-200/10 dark:text-amber-100/80">
              keybindings.toml
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-5 text-amber-950/88 dark:text-amber-50/88">
            Hubris is using the last valid keybindings. Keybinding saves are
            blocked until the file becomes valid again.
          </p>
          <p className="font-mono text-[12px] leading-5 text-amber-900/80 dark:text-amber-100/80">
            {status.message ?? "The keybindings file could not be parsed."}
          </p>
        </div>
      </div>
    </section>
  );
}
