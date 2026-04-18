import { useEffect, useRef, useState } from "react";
import {
  desktopVscodeBridge,
  hasDesktopVscodeBridge,
} from "@/lib/desktopVscode";
import { vscodeBase } from "@/lib/desktopRuntime";
import { useSettingsStore } from "@/lib/stores/settings";
import type { Worktree } from "@/lib/types";
import { cn } from "@/lib/utils";

type Props = {
  worktree: Worktree;
  active: boolean;
};

/** Hosts a persistent VS Code workbench iframe for one worktree. */
export default function VscodeWorkbenchPane({ worktree, active }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previousLoadRef = useRef<string | null>(null);
  const isDesktop = hasDesktopVscodeBridge();
  const runtime = useSettingsStore((state) => state.settings.vscode.runtime);
  const [desktopCreatePayload] = useState(() => ({
    runtime,
    worktreePath: worktree.path,
  }));
  const src = (() => {
    const params = new URLSearchParams({ folder: worktree.path });
    const base = vscodeBase(runtime);
    if (base.startsWith("/")) {
      return `${base}?${params.toString()}`;
    }

    const url = new URL(base);
    url.search = params.toString();
    return url.toString();
  })();

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    const bridge = desktopVscodeBridge();
    if (!bridge) {
      return;
    }

    previousLoadRef.current = `${desktopCreatePayload.runtime}:${desktopCreatePayload.worktreePath}`;
    void bridge.create({
      worktreeId: worktree.id,
      runtime: desktopCreatePayload.runtime,
      worktreePath: desktopCreatePayload.worktreePath,
    });

    return () => {
      bridge.destroy({ worktreeId: worktree.id });
    };
  }, [desktopCreatePayload, isDesktop, worktree.id]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    const nextLoadKey = `${runtime}:${worktree.path}`;
    if (previousLoadRef.current === nextLoadKey) {
      return;
    }
    previousLoadRef.current = nextLoadKey;

    desktopVscodeBridge()?.load({
      worktreeId: worktree.id,
      runtime,
      worktreePath: worktree.path,
    });
  }, [isDesktop, runtime, worktree.id, worktree.path]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    const bridge = desktopVscodeBridge();
    if (!bridge) {
      return;
    }

    if (active) {
      bridge.show({ worktreeId: worktree.id });
    } else {
      bridge.hide({ worktreeId: worktree.id });
    }
  }, [active, isDesktop, worktree.id]);

  useEffect(() => {
    if (!isDesktop || !active) {
      return;
    }

    const bridge = desktopVscodeBridge();
    const host = hostRef.current;
    if (!bridge || !host) {
      return;
    }

    const updateBounds = () => {
      const rect = host.getBoundingClientRect();
      bridge.setBounds({
        worktreeId: worktree.id,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    };

    const observer = new ResizeObserver(() => updateBounds());
    observer.observe(host);
    updateBounds();
    window.addEventListener("resize", updateBounds);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateBounds);
    };
  }, [active, isDesktop, worktree.id]);

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
      {isDesktop ? (
        <div
          ref={hostRef}
          title={`VS Code workbench for ${worktree.name}`}
          className="absolute inset-0 bg-background"
        />
      ) : (
        <iframe
          title={`VS Code workbench for ${worktree.name}`}
          src={src}
          className="h-full w-full border-0 bg-background"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
