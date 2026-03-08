import { useState, useEffect, useMemo } from "react";
import {
  AlertTriangle,
  ChevronsUpDown,
  GitBranch,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  listProjectWorktreeStartPoints,
  type WorktreeStartPoint,
} from "@/lib/api";
import { useThemeStore } from "@/lib/stores/theme";
import { deterministicTagStyle } from "@/lib/theme/deterministicTagColor";
import { generateWorktreeBranchName } from "@/lib/worktreeName";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface AddWorktreeDialogProps {
  projectId: string;
  projectName: string;
  onAdd: (branch: string, startPoint?: string) => Promise<void>;
  onClose: () => void;
}

const BRANCH_BADGE_CLASS =
  "deterministic-tag-badge max-w-full truncate text-xs";

/**
 * Derive a stable color key from a git ref string,
 * stripping well-known prefixes so that e.g.
 * "refs/heads/main" and "origin/main" hash the same.
 */
function branchColorKey(
  ref: string,
  kind: "local" | "remote" = "local",
): string {
  const trimmed = ref.trim();
  if (!trimmed) return "default";

  if (trimmed.startsWith("refs/heads/")) {
    return trimmed.slice("refs/heads/".length);
  }
  if (trimmed.startsWith("refs/remotes/")) {
    const remainder = trimmed.slice("refs/remotes/".length);
    const slashIdx = remainder.indexOf("/");
    return slashIdx === -1 ? remainder : remainder.slice(slashIdx + 1);
  }
  if (kind === "remote") {
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx > 0) {
      return trimmed.slice(slashIdx + 1);
    }
  }
  return trimmed;
}

function branchBadgeStyle(
  ref: string,
  kind: "local" | "remote" = "local",
): string {
  return deterministicTagStyle(branchColorKey(ref, kind), {
    profile: "balanced",
    surfaceVar: "--popover",
  });
}

export function AddWorktreeDialog({
  projectId,
  projectName,
  onAdd,
  onClose,
}: AddWorktreeDialogProps) {
  const [branch, setBranch] = useState("");
  const [suggestedBranch, setSuggestedBranch] = useState(() =>
    generateWorktreeBranchName(),
  );
  const [startPointPopoverOpen, setStartPointPopoverOpen] = useState(false);
  const [selectedStartPointValue, setSelectedStartPointValue] = useState("");
  const [useCustomStartPoint, setUseCustomStartPoint] = useState(false);
  const [customStartPoint, setCustomStartPoint] = useState("");
  const [startPoints, setStartPoints] = useState<WorktreeStartPoint[]>([]);
  const [defaultStartPoint, setDefaultStartPoint] = useState("");
  const [startPointWarning, setStartPointWarning] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Subscribe to theme version for reactive badge colors
  const themeVersion = useThemeStore((s) => s.version);

  const selectedStartPoint = useMemo(
    () =>
      startPoints.find((sp) => sp.value === selectedStartPointValue) ?? null,
    [startPoints, selectedStartPointValue],
  );

  const hasStartPointOptions = startPoints.length > 0;

  const startPointTriggerLabel = useMemo(() => {
    if (useCustomStartPoint) {
      return customStartPoint.trim() || "Custom ref\u2026";
    }
    if (selectedStartPoint?.local_ref) {
      return selectedStartPoint.local_ref;
    }
    if (selectedStartPoint?.remote_refs?.length) {
      return selectedStartPoint.remote_refs[0];
    }
    if (defaultStartPoint) {
      return defaultStartPoint;
    }
    return "Select start point";
  }, [
    useCustomStartPoint,
    customStartPoint,
    selectedStartPoint,
    defaultStartPoint,
  ]);

  useEffect(() => {
    loadStartPoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadStartPoints(): Promise<void> {
    setStartPointWarning("");
    try {
      const response = await listProjectWorktreeStartPoints(projectId);
      setStartPoints(response.start_points);
      const defSp = response.default_start_point?.trim() ?? "";
      setDefaultStartPoint(defSp);

      if (!useCustomStartPoint) {
        const matchedDefault = defSp
          ? response.start_points.find(
              (sp) =>
                sp.value === defSp ||
                sp.local_ref === defSp ||
                sp.remote_refs.includes(defSp),
            )
          : undefined;

        setSelectedStartPointValue(
          matchedDefault?.value || response.start_points[0]?.value || "",
        );
      }
      if (response.git_error) {
        setStartPointWarning(response.git_error);
      }
    } catch (err) {
      setStartPointWarning(
        `Failed to load branches (${(err as Error).message})`,
      );
      setStartPoints([]);
      setDefaultStartPoint("");
      if (!useCustomStartPoint) {
        setSelectedStartPointValue("");
      }
    }
  }

  function rerollSuggestedBranch() {
    setSuggestedBranch((prev) => generateWorktreeBranchName(prev));
  }

  function selectStartPoint(value: string) {
    setSelectedStartPointValue(value);
    setUseCustomStartPoint(false);
    setStartPointPopoverOpen(false);
    setError("");
  }

  function selectCustomStartPoint() {
    setUseCustomStartPoint(true);
    setStartPointPopoverOpen(false);
    setError("");
  }

  async function submit() {
    const effectiveBranch = branch.trim() || suggestedBranch;
    if (!effectiveBranch) return;

    let effectiveStartPoint: string | undefined;
    if (useCustomStartPoint) {
      const custom = customStartPoint.trim();
      if (!custom) {
        setError("Custom start point is required.");
        return;
      }
      effectiveStartPoint = custom;
    } else {
      effectiveStartPoint =
        selectedStartPointValue || defaultStartPoint || undefined;
    }

    setSubmitting(true);
    setError("");
    try {
      await onAdd(effectiveBranch, effectiveStartPoint);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New Worktree</DialogTitle>
          <DialogDescription>
            Create a new linked worktree for {projectName} from a new branch.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2" data-theme-version={themeVersion}>
          {/* Branch name */}
          <div className="space-y-1.5">
            <label
              htmlFor="new-worktree-branch"
              className="text-sm font-medium"
            >
              Branch name
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="new-worktree-branch"
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={suggestedBranch}
                className="flex-1"
                disabled={submitting}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
              <Button
                variant="outline"
                size="icon-sm"
                title="Generate another name"
                aria-label="Generate another name"
                disabled={submitting}
                onClick={rerollSuggestedBranch}
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Start point */}
          <div className="space-y-1.5">
            <label
              htmlFor="new-worktree-start-point"
              className="text-sm font-medium"
            >
              Start from
            </label>
            <Popover
              open={startPointPopoverOpen}
              onOpenChange={setStartPointPopoverOpen}
            >
              <PopoverTrigger
                id="new-worktree-start-point"
                disabled={submitting}
                role="combobox"
                aria-expanded={startPointPopoverOpen}
                className={cn(
                  "border-input ring-offset-background",
                  "focus-visible:border-ring",
                  "focus-visible:ring-ring/50",
                  "aria-invalid:ring-destructive/20",
                  "dark:aria-invalid:ring-destructive/40",
                  "aria-invalid:border-destructive",
                  "flex h-9 w-full items-center",
                  "justify-between rounded-md border",
                  "bg-transparent px-3 py-2 text-sm",
                  "shadow-xs transition-[color,box-shadow]",
                  "outline-none",
                  "disabled:cursor-not-allowed",
                  "disabled:opacity-50",
                  "focus-visible:ring-[3px]",
                )}
              >
                <span
                  className={cn(
                    "flex min-w-0 flex-1 items-center",
                    "gap-1.5 overflow-hidden text-left",
                  )}
                >
                  {useCustomStartPoint ? (
                    <>
                      <Badge variant="outline" className="text-xs">
                        Custom
                      </Badge>
                      <span className="truncate">{startPointTriggerLabel}</span>
                    </>
                  ) : selectedStartPoint ? (
                    <>
                      {selectedStartPoint.local_ref && (
                        <Badge
                          variant="outline"
                          className={BRANCH_BADGE_CLASS}
                          style={cssVarsFromStyle(
                            branchBadgeStyle(selectedStartPoint.local_ref),
                          )}
                        >
                          {selectedStartPoint.local_ref}
                        </Badge>
                      )}
                      {!selectedStartPoint.local_ref &&
                        selectedStartPoint.remote_refs.length === 0 && (
                          <span
                            className={cn("truncate", "text-muted-foreground")}
                          >
                            {startPointTriggerLabel}
                          </span>
                        )}
                      {selectedStartPoint.remote_refs.map((remoteRef) => (
                        <Badge
                          key={remoteRef}
                          variant="outline"
                          className={BRANCH_BADGE_CLASS}
                          style={cssVarsFromStyle(
                            branchBadgeStyle(remoteRef, "remote"),
                          )}
                        >
                          {remoteRef}
                        </Badge>
                      ))}
                    </>
                  ) : (
                    <span className={cn("truncate text-muted-foreground")}>
                      {startPointTriggerLabel}
                    </span>
                  )}
                </span>
                <ChevronsUpDown
                  className={cn("ml-2 h-4 w-4 shrink-0 opacity-50")}
                />
              </PopoverTrigger>
              <PopoverContent
                className={cn(
                  "start-point-popover w-[var(--radix-popover-trigger-width)] p-0",
                )}
                align="start"
              >
                <Command className="start-point-command">
                  <CommandInput
                    className="start-point-command-input"
                    placeholder="Search branches..."
                  />
                  <CommandList>
                    <CommandEmpty>No start points found.</CommandEmpty>
                    {hasStartPointOptions && (
                      <CommandGroup heading="Branches">
                        {startPoints.map((sp) => (
                          <CommandItem
                            key={sp.value}
                            value={sp.value}
                            keywords={[
                              sp.value,
                              sp.sha,
                              sp.local_ref ?? "",
                              ...sp.remote_refs,
                            ]}
                            className={cn("start-point-command-item")}
                            onSelect={() => selectStartPoint(sp.value)}
                          >
                            <GitBranch
                              className={cn("h-4 w-4", "text-muted-foreground")}
                            />
                            <div className="min-w-0 flex-1">
                              <div
                                className={cn(
                                  "flex min-w-0 flex-wrap",
                                  "items-center gap-1",
                                )}
                              >
                                {sp.local_ref && (
                                  <Badge
                                    variant="outline"
                                    className={BRANCH_BADGE_CLASS}
                                    style={cssVarsFromStyle(
                                      branchBadgeStyle(sp.local_ref),
                                    )}
                                  >
                                    {sp.local_ref}
                                  </Badge>
                                )}
                                {sp.remote_refs.map((remoteRef) => (
                                  <Badge
                                    key={remoteRef}
                                    variant="outline"
                                    className={BRANCH_BADGE_CLASS}
                                    style={cssVarsFromStyle(
                                      branchBadgeStyle(remoteRef, "remote"),
                                    )}
                                  >
                                    {remoteRef}
                                  </Badge>
                                ))}
                                {!sp.local_ref &&
                                  sp.remote_refs.length === 0 && (
                                    <span className="truncate">{sp.value}</span>
                                  )}
                              </div>
                              <p
                                className={cn(
                                  "mt-1 text-[11px]",
                                  "text-muted-foreground",
                                )}
                              >
                                commit {sp.sha.slice(0, 8)}
                              </p>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    <CommandSeparator
                      className={cn("start-point-command-separator")}
                    />
                    <CommandGroup heading="Advanced">
                      <CommandItem
                        value="custom-ref-option"
                        keywords={["custom", "manual", "sha", "ref"]}
                        className={cn("start-point-command-item")}
                        onSelect={selectCustomStartPoint}
                      >
                        <Sparkles
                          className={cn("h-4 w-4", "text-muted-foreground")}
                        />
                        <div className="flex flex-col">
                          <span>Custom ref&hellip;</span>
                          <span
                            className={cn("text-xs", "text-muted-foreground")}
                          >
                            Use a tag, hash, or custom revision
                          </span>
                        </div>
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {useCustomStartPoint && (
              <Input
                id="new-worktree-custom-start-point"
                type="text"
                value={customStartPoint}
                onChange={(e) => {
                  setCustomStartPoint(e.target.value);
                  if (error === "Custom start point is required.") {
                    setError("");
                  }
                }}
                placeholder={defaultStartPoint || "origin/main or commit SHA"}
                disabled={submitting}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            )}
          </div>

          {startPointWarning && (
            <p
              className={cn(
                "flex items-center gap-1.5",
                "text-xs text-amber-600",
              )}
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {startPointWarning}
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Convert a semicolon-separated CSS property string
 * (from deterministicTagStyle) into a CSSProperties
 * object so React can apply it as inline style.
 */
function cssVarsFromStyle(styleStr: string): React.CSSProperties {
  const result: Record<string, string> = {};
  for (const part of styleStr.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const key = part.slice(0, colon).trim();
    const val = part.slice(colon + 1).trim();
    if (key && val) {
      result[key] = val;
    }
  }
  return result as React.CSSProperties;
}
