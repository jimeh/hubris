import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  Folder,
  FolderGit2,
  House,
  ArrowUp,
  RotateCcw,
  Eye,
  EyeOff,
} from "lucide-react";
import { listFiles } from "@/lib/api";
import type { DirEntry } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface FileBrowserProps {
  currentPath: string;
  onPathChange: (path: string) => void;
  onSelect: (path: string) => void;
}

export function FileBrowser({
  currentPath,
  onPathChange,
  onSelect,
}: FileBrowserProps) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [browsedPath, setBrowsedPath] = useState("");

  // Track whether showHidden has been initialized
  const showHiddenInit = useRef(false);

  const pathSegments = useMemo(() => {
    if (!browsedPath) return [];
    const parts = browsedPath.split("/").filter(Boolean);
    return parts.map((part, i) => ({
      name: part,
      path: "/" + parts.slice(0, i + 1).join("/"),
    }));
  }, [browsedPath]);

  const fetchEntries = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError("");
      setFocusedIndex(-1);
      try {
        const res = await listFiles(path, showHidden);
        setEntries(res.entries);
        setBrowsedPath(res.path);
        onPathChange(res.path);
        if (res.home_dir) setHomeDir(res.home_dir);
      } catch (e) {
        setError((e as Error).message);
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    // showHidden is intentionally captured at call time
    // via the state value; onPathChange is stable from
    // the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showHidden],
  );

  const navigateTo = useCallback(
    (path: string) => {
      fetchEntries(path);
    },
    [fetchEntries],
  );

  const navigateToEntry = useCallback(
    (entry: DirEntry) => {
      const sep = browsedPath.endsWith("/") ? "" : "/";
      navigateTo(browsedPath + sep + entry.name);
    },
    [browsedPath, navigateTo],
  );

  const navigateToParent = useCallback(() => {
    const parent = browsedPath.replace(/\/[^/]+\/?$/, "") || "/";
    navigateTo(parent);
  }, [browsedPath, navigateTo]);

  // Initial load
  useEffect(() => {
    fetchEntries();
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced fetch when currentPath changes externally
  useEffect(() => {
    if (currentPath === browsedPath) return;

    const timer = setTimeout(() => {
      if (currentPath.trim()) {
        fetchEntries(currentPath);
      }
    }, 400);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  // Re-fetch on showHidden toggle (skip initial)
  useEffect(() => {
    if (!showHiddenInit.current) {
      showHiddenInit.current = true;
      return;
    }
    if (browsedPath) {
      fetchEntries(browsedPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHidden]);

  function handleKeydown(e: React.KeyboardEvent) {
    if (entries.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, entries.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (focusedIndex >= 0) {
          navigateToEntry(entries[focusedIndex]);
        }
        break;
      case "Backspace":
        e.preventDefault();
        navigateToParent();
        break;
    }
  }

  return (
    <>
      {/* Breadcrumb navigation */}
      <div
        className={cn(
          "flex items-center gap-0 overflow-x-auto",
          "text-[13px] font-mono text-muted-foreground",
          "pb-2 [scrollbar-width:none]",
          "[&::-webkit-scrollbar]:hidden",
        )}
      >
        <button
          className={cn(
            "shrink-0 px-1 hover:text-foreground",
            "transition-colors",
          )}
          onClick={() => navigateTo("/")}
        >
          /
        </button>
        {pathSegments.map((segment) => (
          <span key={segment.path} className="flex items-center">
            <button
              className={cn(
                "shrink-0 truncate max-w-[140px] px-0.5",
                "hover:text-foreground hover:underline",
                "underline-offset-2 transition-colors",
              )}
              onClick={() => navigateTo(segment.path)}
            >
              {segment.name}
            </button>
            <span className="shrink-0 opacity-40">/</span>
          </span>
        ))}
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-0.5 pb-2">
        {homeDir && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigateTo(homeDir)}
            title="Home directory"
          >
            <House className="h-3.5 w-3.5" />
          </Button>
        )}
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
          onClick={() => fetchEntries(browsedPath)}
          title="Refresh"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setShowHidden((v) => !v)}
          className={showHidden ? "text-foreground" : ""}
          title={showHidden ? "Hide dotfiles" : "Show dotfiles"}
        >
          {showHidden ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Directory listing */}
      <ScrollArea className="h-[280px] rounded-md border">
        <div
          className="p-1"
          role="listbox"
          tabIndex={0}
          onKeyDown={handleKeydown}
        >
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className={cn("flex items-center gap-2 px-2 py-1.5")}
              >
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-4 w-32 rounded" />
              </div>
            ))
          ) : error ? (
            <div
              className={cn(
                "flex flex-col items-center gap-2",
                "py-8 text-sm text-muted-foreground",
              )}
            >
              <p className="text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchEntries(browsedPath)}
              >
                Retry
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div
              className={cn(
                "px-2 py-6 text-[13px] font-mono",
                "text-muted-foreground/60",
              )}
            >
              (empty)
            </div>
          ) : (
            entries.map((entry, i) => (
              <button
                key={entry.name}
                className={cn(
                  "flex w-full items-center gap-2",
                  "rounded-sm px-2 py-1 text-sm",
                  "text-left transition-colors",
                  "hover:bg-accent/50",
                  i === focusedIndex && "bg-accent text-accent-foreground",
                  entry.is_git_repo
                    ? "border-l-2 border-primary"
                    : "border-l-2 border-transparent",
                )}
                onClick={() => navigateToEntry(entry)}
                onDoubleClick={() => {
                  const sep = browsedPath.endsWith("/") ? "" : "/";
                  onSelect(browsedPath + sep + entry.name);
                }}
                role="option"
                aria-selected={i === focusedIndex}
              >
                {entry.is_git_repo ? (
                  <FolderGit2 className={cn("h-4 w-4 shrink-0 text-primary")} />
                ) : (
                  <Folder
                    className={cn("h-4 w-4 shrink-0", "text-muted-foreground")}
                  />
                )}
                <span className="truncate font-mono text-[13px]">
                  {entry.name}
                </span>
              </button>
            ))
          )}
        </div>
      </ScrollArea>
    </>
  );
}
