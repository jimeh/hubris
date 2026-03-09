import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronsUpDown,
  GitBranch,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  type WorktreeStartPoint,
  listProjectWorktreeStartPoints,
} from "@/lib/api";
import { deterministicTagStyle } from "@/lib/theme/deterministicTagColor";
import { generateWorktreeBranchName } from "@/lib/worktreeName";
import { useThemeStore } from "@/lib/stores/theme";
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
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger } from "@/components/ui/popover";
import { Popover as PopoverPrimitive } from "radix-ui";

type Props = {
  projectId: string;
  projectName: string;
  onAdd: (
    branch: string,
    startPoint?: string,
    sourceRef?: string,
  ) => Promise<void>;
  onClose: () => void;
};

function DialogScopedPopoverContent({
  portalContainer,
  className,
  align = "center",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  portalContainer: HTMLElement | null;
}) {
  return (
    <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "pointer-events-auto z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

function tagStyle(
  ref: string,
  kind: "local" | "remote" = "local",
): React.CSSProperties {
  const trimmed = ref.trim();
  const stableKey = (() => {
    if (!trimmed) {
      return "default";
    }
    if (trimmed.startsWith("refs/heads/")) {
      return trimmed.slice("refs/heads/".length);
    }
    if (trimmed.startsWith("refs/remotes/")) {
      const remainder = trimmed.slice("refs/remotes/".length);
      const slashIndex = remainder.indexOf("/");
      return slashIndex === -1 ? remainder : remainder.slice(slashIndex + 1);
    }
    if (kind === "remote") {
      const slashIndex = trimmed.indexOf("/");
      if (slashIndex > 0) {
        return trimmed.slice(slashIndex + 1);
      }
    }
    return trimmed;
  })();

  return Object.fromEntries(
    deterministicTagStyle(stableKey, {
      profile: "balanced",
      surfaceVar: "--popover",
    })
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, value] = entry.split(":");
        return [key.trim(), value.trim()];
      }),
  ) as React.CSSProperties;
}

export default function AddWorktreeDialog({
  projectId,
  projectName,
  onAdd,
  onClose,
}: Props) {
  const themeVersion = useThemeStore((state) => state.version);
  const [branch, setBranch] = useState("");
  const [suggestedBranch, setSuggestedBranch] = useState(
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
  const [startPointPopoverContainer, setStartPointPopoverContainer] =
    useState<HTMLDivElement | null>(null);

  const selectedStartPoint = useMemo(
    () =>
      startPoints.find(
        (startPoint) => startPoint.value === selectedStartPointValue,
      ) ?? null,
    [selectedStartPointValue, startPoints],
  );
  const selectedSourceRef = useMemo(() => {
    if (useCustomStartPoint) {
      return undefined;
    }

    return (
      selectedStartPoint?.local_ref ??
      selectedStartPoint?.remote_refs[0] ??
      undefined
    );
  }, [selectedStartPoint, useCustomStartPoint]);

  const startPointTriggerLabel = useMemo(() => {
    if (useCustomStartPoint) {
      return customStartPoint.trim() || "Custom ref…";
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
    customStartPoint,
    defaultStartPoint,
    selectedStartPoint,
    useCustomStartPoint,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        setStartPointWarning("");
        try {
          const response = await listProjectWorktreeStartPoints(projectId);
          setStartPoints(response.start_points);
          const nextDefault = response.default_start_point?.trim() ?? "";
          setDefaultStartPoint(nextDefault);
          const matchedDefault = nextDefault
            ? response.start_points.find(
                (startPoint) =>
                  startPoint.value === nextDefault ||
                  startPoint.local_ref === nextDefault ||
                  startPoint.remote_refs.includes(nextDefault),
              )
            : undefined;
          setSelectedStartPointValue(
            matchedDefault?.value || response.start_points[0]?.value || "",
          );
          if (response.git_error) {
            setStartPointWarning(response.git_error);
          }
        } catch (loadError) {
          setStartPointWarning(
            `Failed to load branches (${(loadError as Error).message})`,
          );
          setStartPoints([]);
          setDefaultStartPoint("");
          setSelectedStartPointValue("");
        }
      })();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [projectId]);

  async function submit(): Promise<void> {
    const effectiveBranch = branch.trim() || suggestedBranch;
    if (!effectiveBranch) {
      return;
    }

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
      await onAdd(effectiveBranch, effectiveStartPoint, selectedSourceRef);
    } catch (submitError) {
      setError((submitError as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <div
          ref={setStartPointPopoverContainer}
          className="pointer-events-none absolute inset-0 z-50"
          data-start-point-popover-container
        />
        <DialogHeader>
          <DialogTitle>New Worktree</DialogTitle>
          <DialogDescription>
            Create a new linked worktree for {projectName} from a new branch.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2" data-theme-version={themeVersion}>
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
                placeholder={suggestedBranch}
                className="flex-1"
                disabled={submitting}
                onChange={(event) => setBranch(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void submit();
                  }
                }}
              />
              <Button
                variant="outline"
                size="icon-sm"
                title="Generate another name"
                aria-label="Generate another name"
                disabled={submitting}
                onClick={() =>
                  setSuggestedBranch((value) =>
                    generateWorktreeBranchName(value),
                  )
                }
              >
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </div>

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
              <PopoverTrigger asChild>
                <Button
                  id="new-worktree-start-point"
                  variant="outline"
                  disabled={submitting}
                  role="combobox"
                  aria-expanded={startPointPopoverOpen}
                  className="h-auto w-full justify-between px-3 py-2"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left">
                    {useCustomStartPoint ? (
                      <>
                        <Badge variant="outline" className="text-xs">
                          Custom
                        </Badge>
                        <span className="truncate">
                          {startPointTriggerLabel}
                        </span>
                      </>
                    ) : selectedStartPoint ? (
                      <>
                        {selectedStartPoint.local_ref ? (
                          <Badge
                            variant="outline"
                            className="deterministic-tag-badge max-w-full truncate text-xs"
                            style={tagStyle(selectedStartPoint.local_ref)}
                          >
                            {selectedStartPoint.local_ref}
                          </Badge>
                        ) : null}
                        {!selectedStartPoint.local_ref &&
                        selectedStartPoint.remote_refs.length === 0 ? (
                          <span className="truncate text-muted-foreground">
                            {startPointTriggerLabel}
                          </span>
                        ) : null}
                        {selectedStartPoint.remote_refs.map((remoteRef) => (
                          <Badge
                            key={remoteRef}
                            variant="outline"
                            className="deterministic-tag-badge max-w-full truncate text-xs"
                            style={tagStyle(remoteRef, "remote")}
                          >
                            {remoteRef}
                          </Badge>
                        ))}
                      </>
                    ) : (
                      <span className="truncate text-muted-foreground">
                        {startPointTriggerLabel}
                      </span>
                    )}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <DialogScopedPopoverContent
                portalContainer={startPointPopoverContainer}
                className="start-point-popover w-[var(--radix-popover-trigger-width)] p-0"
                align="start"
              >
                <Command className="start-point-command">
                  <CommandInput
                    className="start-point-command-input"
                    placeholder="Search branches..."
                  />
                  <CommandList>
                    <CommandEmpty>No start points found.</CommandEmpty>
                    {startPoints.length > 0 ? (
                      <CommandGroup heading="Branches">
                        {startPoints.map((startPoint) => (
                          <CommandItem
                            key={startPoint.value}
                            value={startPoint.value}
                            keywords={[
                              startPoint.value,
                              startPoint.sha,
                              startPoint.local_ref ?? "",
                              ...startPoint.remote_refs,
                            ]}
                            className="start-point-command-item"
                            onSelect={() => {
                              setSelectedStartPointValue(startPoint.value);
                              setUseCustomStartPoint(false);
                              setStartPointPopoverOpen(false);
                              setError("");
                            }}
                          >
                            <GitBranch className="h-4 w-4 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 flex-wrap items-center gap-1">
                                {startPoint.local_ref ? (
                                  <Badge
                                    variant="outline"
                                    className="deterministic-tag-badge max-w-full truncate text-xs"
                                    style={tagStyle(startPoint.local_ref)}
                                  >
                                    {startPoint.local_ref}
                                  </Badge>
                                ) : null}
                                {startPoint.remote_refs.map((remoteRef) => (
                                  <Badge
                                    key={remoteRef}
                                    variant="outline"
                                    className="deterministic-tag-badge max-w-full truncate text-xs"
                                    style={tagStyle(remoteRef, "remote")}
                                  >
                                    {remoteRef}
                                  </Badge>
                                ))}
                                {!startPoint.local_ref &&
                                startPoint.remote_refs.length === 0 ? (
                                  <span className="truncate">
                                    {startPoint.value}
                                  </span>
                                ) : null}
                              </div>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                commit {startPoint.sha.slice(0, 8)}
                              </p>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ) : null}
                    <CommandSeparator className="start-point-command-separator" />
                    <CommandGroup heading="Advanced">
                      <CommandItem
                        value="custom-ref-option"
                        keywords={["custom", "manual", "sha", "ref"]}
                        className="start-point-command-item"
                        onSelect={() => {
                          setUseCustomStartPoint(true);
                          setStartPointPopoverOpen(false);
                          setError("");
                        }}
                      >
                        <Sparkles className="h-4 w-4 text-muted-foreground" />
                        <div className="flex flex-col">
                          <span>Custom ref…</span>
                          <span className="text-xs text-muted-foreground">
                            Use a tag, hash, or custom revision
                          </span>
                        </div>
                      </CommandItem>
                    </CommandGroup>
                  </CommandList>
                </Command>
              </DialogScopedPopoverContent>
            </Popover>

            {useCustomStartPoint ? (
              <Input
                id="new-worktree-custom-start-point"
                type="text"
                value={customStartPoint}
                placeholder={defaultStartPoint || "origin/main or commit SHA"}
                disabled={submitting}
                onChange={(event) => {
                  setCustomStartPoint(event.currentTarget.value);
                  if (error === "Custom start point is required.") {
                    setError("");
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void submit();
                  }
                }}
              />
            ) : null}
          </div>

          {startPointWarning ? (
            <p className="flex items-center gap-1.5 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {startPointWarning}
            </p>
          ) : null}

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
