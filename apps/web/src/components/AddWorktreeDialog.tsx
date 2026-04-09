import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ChevronsUpDown,
  Download,
  GitBranch,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  type ImportableWorktree,
  type WorktreeStartPoint,
  listImportableWorktrees,
  listProjectWorktreeStartPoints,
} from "@/lib/api";
import { tagStyle } from "@/lib/theme/tagStyle";
import { generateWorktreeBranchName } from "@/lib/worktreeName";
import { useThemeSettings } from "@/lib/stores/theme";
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
  onImport: (path: string) => Promise<void>;
  onClose: () => void;
};

type ActiveTab = "create" | "import";

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

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium",
        "transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type CreatePanelHandle = { submit: () => void };

const CreatePanel = forwardRef<
  CreatePanelHandle,
  {
    projectId: string;
    submitting: boolean;
    onSubmit: (
      branch: string,
      startPoint?: string,
      sourceRef?: string,
    ) => Promise<void>;
  }
>(function CreatePanel({ projectId, submitting, onSubmit }, ref) {
  const themeVersion = useThemeSettings((state) => state.version);
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

    setError("");
    try {
      const matchedStartPoint =
        useCustomStartPoint || !effectiveStartPoint
          ? undefined
          : startPoints.find(
              (startPoint) =>
                startPoint.value === effectiveStartPoint ||
                startPoint.local_ref === effectiveStartPoint ||
                startPoint.remote_refs.includes(effectiveStartPoint),
            );
      const sourceRef =
        matchedStartPoint?.remote_refs[0] ??
        matchedStartPoint?.local_ref ??
        undefined;

      await onSubmit(effectiveBranch, effectiveStartPoint, sourceRef);
    } catch (submitError) {
      setError((submitError as Error).message);
    }
  }

  useImperativeHandle(ref, () => ({ submit: () => void submit() }));

  return (
    <>
      <div
        ref={setStartPointPopoverContainer}
        className="pointer-events-none absolute inset-0 z-50"
        data-start-point-popover-container
      />
      <div className="space-y-3 py-2" data-theme-version={themeVersion}>
        <div className="space-y-1.5">
          <label htmlFor="new-worktree-branch" className="text-sm font-medium">
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
                setSuggestedBranch((value) => generateWorktreeBranchName(value))
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
                      <span className="truncate">{startPointTriggerLabel}</span>
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
    </>
  );
});

function ImportPanel({
  projectId,
  submitting,
  selectedPath,
  onSelect,
}: {
  projectId: string;
  submitting: boolean;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  const [worktrees, setWorktrees] = useState<ImportableWorktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const response = await listImportableWorktrees(projectId);
        if (cancelled) return;
        setWorktrees(response.importable_worktrees);
        if (response.git_error) {
          setError(response.git_error);
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(`Failed to list worktrees (${(loadError as Error).message})`);
        setWorktrees([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && worktrees.length === 0) {
    return (
      <p className="flex items-center gap-1.5 py-4 text-sm text-amber-600">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {error}
      </p>
    );
  }

  if (worktrees.length === 0) {
    return (
      <div className="py-6 text-center">
        <Download className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          No external worktrees found.
        </p>
        <p className="mt-1 text-xs text-muted-foreground/70">
          Create worktrees outside Hubris with{" "}
          <code className="rounded bg-muted px-1 py-0.5">git worktree add</code>{" "}
          and they will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 py-2">
      {error ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {worktrees.map((wt) => (
          <button
            key={wt.id}
            type="button"
            disabled={submitting}
            className={cn(
              "flex w-full items-start gap-3 rounded-lg border p-3",
              "text-left transition-colors",
              selectedPath === wt.path
                ? "border-primary/40 bg-primary/5"
                : "border-transparent bg-muted/25 hover:bg-muted/50",
            )}
            onClick={() => onSelect(selectedPath === wt.path ? null : wt.path)}
          >
            <GitBranch className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              {wt.branch ? (
                <p className="truncate text-sm font-medium">{wt.branch}</p>
              ) : null}
              <p className="truncate text-xs text-muted-foreground">
                {wt.path}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function AddWorktreeDialog({
  projectId,
  projectName,
  onAdd,
  onImport,
  onClose,
}: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("create");
  const createPanelRef = useRef<CreatePanelHandle | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [importSelectedPath, setImportSelectedPath] = useState<string | null>(
    null,
  );
  const [importError, setImportError] = useState("");

  async function handleCreate(
    branch: string,
    startPoint?: string,
    sourceRef?: string,
  ): Promise<void> {
    setSubmitting(true);
    try {
      await onAdd(branch, startPoint, sourceRef);
    } catch (error) {
      setSubmitting(false);
      throw error;
    }
  }

  async function handleImport(): Promise<void> {
    if (!importSelectedPath) return;
    setSubmitting(true);
    setImportError("");
    try {
      await onImport(importSelectedPath);
    } catch (error) {
      setImportError((error as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {activeTab === "create" ? "New Worktree" : "Import Worktree"}
          </DialogTitle>
          <DialogDescription>
            {activeTab === "create"
              ? `Create a new linked worktree for ${projectName} from a new branch.`
              : `Import an existing git worktree into ${projectName}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg border bg-muted/40 p-1">
          <TabButton
            active={activeTab === "create"}
            onClick={() => setActiveTab("create")}
          >
            Create
          </TabButton>
          <TabButton
            active={activeTab === "import"}
            onClick={() => setActiveTab("import")}
          >
            Import
          </TabButton>
        </div>

        {activeTab === "create" ? (
          <CreatePanel
            ref={createPanelRef}
            projectId={projectId}
            submitting={submitting}
            onSubmit={handleCreate}
          />
        ) : (
          <>
            <ImportPanel
              projectId={projectId}
              submitting={submitting}
              selectedPath={importSelectedPath}
              onSelect={setImportSelectedPath}
            />
            {importError ? (
              <p className="text-sm text-destructive">{importError}</p>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {activeTab === "create" ? (
            <Button
              disabled={submitting}
              onClick={() => createPanelRef.current?.submit()}
            >
              Create
            </Button>
          ) : (
            <Button
              disabled={submitting || !importSelectedPath}
              onClick={() => void handleImport()}
            >
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
