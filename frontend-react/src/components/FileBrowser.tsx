import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  House,
  RotateCcw,
} from "lucide-react";
import { listFiles } from "$lib/api";
import type { DirEntry } from "$lib/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";

type Props = {
  currentPath: string;
  onCurrentPathChange: (path: string) => void;
  onSelect: (path: string) => void;
};

export default function FileBrowser({
  currentPath,
  onCurrentPathChange,
  onSelect,
}: Props) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [browsedPath, setBrowsedPath] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHiddenRef = useRef(showHidden);
  const browsedPathRef = useRef("");

  useEffect(() => {
    showHiddenRef.current = showHidden;
  }, [showHidden]);

  useEffect(() => {
    browsedPathRef.current = browsedPath;
  }, [browsedPath]);

  const pathSegments = useMemo(() => {
    if (!browsedPath) {
      return [];
    }

    const parts = browsedPath.split("/").filter(Boolean);
    return parts.map((part, index) => ({
      name: part,
      path: `/${parts.slice(0, index + 1).join("/")}`,
    }));
  }, [browsedPath]);

  const fetchEntries = useCallback(
    async (
      path?: string,
      options?: { showHidden?: boolean },
    ): Promise<void> => {
      setLoading(true);
      setError("");
      setFocusedIndex(-1);

      try {
        const response = await listFiles(
          path,
          options?.showHidden ?? showHiddenRef.current,
        );
        setEntries(response.entries);
        setBrowsedPath(response.path);
        onCurrentPathChange(response.path);
        if (response.home_dir) {
          setHomeDir(response.home_dir);
        }
      } catch (fetchError) {
        setError((fetchError as Error).message);
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [onCurrentPathChange],
  );

  useEffect(() => {
    void fetchEntries();
  }, [fetchEntries]);

  useEffect(() => {
    if (currentPath === browsedPath) {
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      if (currentPath.trim()) {
        void fetchEntries(currentPath);
      }
    }, 400);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [browsedPath, currentPath, fetchEntries]);

  useEffect(() => {
    if (!browsedPathRef.current) {
      return;
    }

    void fetchEntries(browsedPathRef.current, { showHidden });
  }, [fetchEntries, showHidden]);

  function navigateTo(path: string): void {
    void fetchEntries(path);
  }

  function navigateToEntry(entry: DirEntry): void {
    const separator = browsedPath.endsWith("/") ? "" : "/";
    navigateTo(`${browsedPath}${separator}${entry.name}`);
  }

  function navigateToParent(): void {
    const parent = browsedPath.replace(/\/[^/]+\/?$/, "") || "/";
    navigateTo(parent);
  }

  return (
    <>
      <div className="flex items-center gap-0 overflow-x-auto pb-2 text-[13px] font-mono text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <button
          className="shrink-0 px-1 transition-colors hover:text-foreground"
          onClick={() => navigateTo("/")}
          type="button"
        >
          /
        </button>
        {pathSegments.map((segment) => (
          <span key={segment.path} className="flex shrink-0 items-center">
            <button
              className="max-w-[140px] truncate px-0.5 underline-offset-2 transition-colors hover:text-foreground hover:underline"
              onClick={() => navigateTo(segment.path)}
              type="button"
            >
              {segment.name}
            </button>
            <span className="shrink-0 opacity-40">/</span>
          </span>
        ))}
      </div>

      <div className="flex items-center gap-0.5 pb-2">
        {homeDir ? (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigateTo(homeDir)}
            title="Home directory"
          >
            <House className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={navigateToParent}
          title="Parent directory"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void fetchEntries(browsedPath)}
          title="Refresh"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          disabled={!browsedPath}
          onClick={() => {
            if (!browsedPath) {
              return;
            }
            onSelect(browsedPath);
          }}
        >
          Select folder
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShowHidden((value) => !value)}
          className={showHidden ? "text-foreground" : undefined}
          title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
        >
          {showHidden ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      <ScrollArea className="h-[280px] rounded-md border">
        <div
          className="p-1"
          role="listbox"
          tabIndex={0}
          onKeyDown={(event) => {
            if (entries.length === 0) {
              return;
            }

            switch (event.key) {
              case "ArrowDown":
                event.preventDefault();
                setFocusedIndex((value) =>
                  Math.min(value + 1, entries.length - 1),
                );
                break;
              case "ArrowUp":
                event.preventDefault();
                setFocusedIndex((value) => Math.max(value - 1, 0));
                break;
              case "Enter":
                event.preventDefault();
                if (focusedIndex >= 0) {
                  navigateToEntry(entries[focusedIndex]);
                }
                break;
              case "s":
              case "S":
                event.preventDefault();
                if (browsedPath) {
                  onSelect(browsedPath);
                }
                break;
              case "Backspace":
                event.preventDefault();
                navigateToParent();
                break;
            }
          }}
        >
          {loading ? (
            Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="flex items-center gap-2 px-2 py-1.5">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 w-32 rounded" />
              </div>
            ))
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
              <p className="text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchEntries(browsedPath)}
              >
                Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="px-2 py-6 text-[13px] font-mono text-muted-foreground/60">
              (empty)
            </div>
          ) : (
            entries.map((entry, index) => {
              const separator = browsedPath.endsWith("/") ? "" : "/";
              const selectedPath = `${browsedPath}${separator}${entry.name}`;
              return (
                <button
                  key={entry.name}
                  className={[
                    "flex w-full items-center gap-2 rounded-sm border-l-2 px-2 py-1 text-left text-sm transition-colors hover:bg-accent/50",
                    index === focusedIndex
                      ? "bg-accent text-accent-foreground"
                      : "",
                    entry.is_git_repo ? "border-primary" : "border-transparent",
                  ].join(" ")}
                  onClick={() => navigateToEntry(entry)}
                  onDoubleClick={() => onSelect(selectedPath)}
                  role="option"
                  aria-selected={index === focusedIndex}
                  type="button"
                >
                  {entry.is_git_repo ? (
                    <FolderGit2 className="h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>
    </>
  );
}
