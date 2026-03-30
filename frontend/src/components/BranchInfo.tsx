import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, GitBranch, X } from "lucide-react";
import {
  type WorktreeStartPoint,
  listProjectWorktreeStartPoints,
} from "@/lib/api";
import { tagStyle } from "@/lib/theme/tagStyle";
import { useWorktreeStore } from "@/lib/stores/worktrees";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type RefItem = { ref: string; kind: "local" | "remote" };

/** Deduplicate refs from start points, preferring local over remote. */
function uniqueRefs(startPoints: WorktreeStartPoint[]): RefItem[] {
  const seen = new Map<string, RefItem>();
  for (const sp of startPoints) {
    if (sp.local_ref && !seen.has(sp.local_ref)) {
      seen.set(sp.local_ref, { ref: sp.local_ref, kind: "local" });
    }
    for (const remote of sp.remote_refs) {
      if (!seen.has(remote)) {
        seen.set(remote, { ref: remote, kind: "remote" });
      }
    }
    // Fallback for start points with neither local nor remote refs.
    if (!sp.local_ref && sp.remote_refs.length === 0) {
      if (!seen.has(sp.value)) {
        seen.set(sp.value, { ref: sp.value, kind: "local" });
      }
    }
  }
  return [...seen.values()];
}

function SourceRefPicker({
  projectId,
  worktreeId,
  sourceRef,
}: {
  projectId: string;
  worktreeId: string;
  sourceRef: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [startPoints, setStartPoints] = useState<WorktreeStartPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const updateSourceRef = useWorktreeStore((state) => state.updateSourceRef);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await listProjectWorktreeStartPoints(projectId);
        if (cancelled) return;
        setStartPoints(response.start_points);
      } catch {
        if (cancelled) return;
        setStartPoints([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  const handleSelect = useCallback(
    (ref: string | null) => {
      setOpen(false);
      void updateSourceRef(projectId, worktreeId, ref);
    },
    [projectId, worktreeId, updateSourceRef],
  );

  const refItems = useMemo(() => uniqueRefs(startPoints), [startPoints]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center rounded-sm px-1 py-0.5 hover:bg-accent/50"
          aria-label="Change target branch"
        >
          {sourceRef ? (
            <Badge
              variant="outline"
              className="deterministic-tag-badge max-w-[12rem] gap-1 truncate text-xs"
              style={tagStyle(sourceRef, "remote")}
            >
              <GitBranch />
              {sourceRef}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">Set target...</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search branches..." />
          <CommandList>
            <CommandEmpty>
              {loading ? "Loading..." : "No branches found."}
            </CommandEmpty>
            {sourceRef ? (
              <>
                <CommandGroup>
                  <CommandItem
                    value="__clear__"
                    keywords={["clear", "none", "remove"]}
                    onSelect={() => handleSelect(null)}
                  >
                    <X className="text-muted-foreground" />
                    Clear target branch
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            ) : null}
            {refItems.length > 0 ? (
              <CommandGroup heading="Branches">
                {refItems.map(({ ref, kind }) => (
                  <CommandItem
                    key={ref}
                    value={ref}
                    onSelect={() => handleSelect(ref)}
                  >
                    <Badge
                      variant="outline"
                      className="deterministic-tag-badge max-w-full gap-1 truncate text-xs"
                      style={tagStyle(ref, kind)}
                    >
                      <GitBranch />
                      {ref}
                    </Badge>
                    {ref === sourceRef ? (
                      <Check className="ml-auto shrink-0" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function BranchRenameButton({
  projectId,
  worktreeId,
  branch,
}: {
  projectId: string;
  worktreeId: string;
  branch: string;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(branch);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameBranch = useWorktreeStore((state) => state.renameBranch);

  useEffect(() => {
    if (open) {
      setValue(branch);
      setError("");
    }
  }, [open, branch]);

  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => {
        inputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === branch) {
      setOpen(false);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await renameBranch(projectId, worktreeId, trimmed);
      setOpen(false);
    } catch (err) {
      setError(`Rename failed: ${(err as Error).message || "unknown error"}`);
    } finally {
      setSubmitting(false);
    }
  }, [value, branch, projectId, worktreeId, renameBranch]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center rounded-sm px-1 py-0.5 hover:bg-accent/50"
          aria-label="Rename branch"
        >
          <Badge
            variant="outline"
            className="deterministic-tag-badge max-w-[12rem] gap-1 truncate text-xs"
            style={tagStyle(branch)}
          >
            <GitBranch />
            {branch}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium">Rename branch</p>
          <Input
            ref={inputRef}
            value={value}
            disabled={submitting}
            onChange={(e) => {
              setValue(e.currentTarget.value);
              if (error) setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleSubmit();
              }
              if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function BranchInfo({
  projectId,
  worktreeId,
  branch,
  sourceRef,
}: {
  projectId: string;
  worktreeId: string;
  branch: string;
  sourceRef: string | null;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <SourceRefPicker
        projectId={projectId}
        worktreeId={worktreeId}
        sourceRef={sourceRef}
      />
      <ArrowLeft className="size-3 shrink-0 text-muted-foreground" />
      <BranchRenameButton
        projectId={projectId}
        worktreeId={worktreeId}
        branch={branch}
      />
    </div>
  );
}
