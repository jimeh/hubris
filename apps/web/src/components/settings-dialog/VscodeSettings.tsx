import { useState } from "react";
import {
  Activity,
  CircleOff,
  Download,
  Loader2,
  Package,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  checkVscodeUpdate,
  installVscode,
  restartVscode,
  startVscode,
  stopVscode,
  type VscodeInstallProgress,
  type VscodeRuntimeStatus,
  type VscodeStatus,
} from "@/lib/api";
import { useSettingsStore } from "@/lib/stores/settings";
import { useTaskStore } from "@/lib/stores/tasks";
import { setVscodeStatus, useVscodeStore } from "@/lib/stores/vscode";

type VscodeRuntimeKind = "vscodeCli" | "codeServer";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start sm:gap-3";

type ActionKind =
  | "check"
  | "install"
  | "reinstall"
  | "upgrade"
  | "start"
  | "stop"
  | "restart"
  | null;

const RUNTIME_META: Record<
  VscodeRuntimeKind,
  {
    label: string;
    managedBy: string;
    readyLabel: string;
    downloadLabel: string;
  }
> = {
  vscodeCli: {
    label: "Official VS Code CLI",
    managedBy: "Official VS Code CLI",
    readyLabel: "VS Code CLI serve-web is ready for /code.",
    downloadLabel: "VS Code CLI",
  },
  codeServer: {
    label: "coder/code-server",
    managedBy: "coder/code-server",
    readyLabel: "coder/code-server is ready for /code.",
    downloadLabel: "coder/code-server",
  },
};

function statusBadgeVariant(status: VscodeRuntimeStatus["processStatus"]) {
  switch (status) {
    case "running":
      return "default";
    case "error":
      return "destructive";
    case "starting":
    case "stopping":
    case "installing":
      return "secondary";
    case "stopped":
    default:
      return "outline";
  }
}

function statusLabel(status: VscodeRuntimeStatus["processStatus"]) {
  switch (status) {
    case "running":
      return "Running";
    case "starting":
      return "Starting";
    case "stopping":
      return "Stopping";
    case "installing":
      return "Installing";
    case "error":
      return "Error";
    case "stopped":
    default:
      return "Stopped";
  }
}

function displayVersion(version: string | null | undefined): string | null {
  if (!version) {
    return null;
  }

  return version.replace(/^v/i, "");
}

function statusSummary(status: VscodeRuntimeStatus | null | undefined): string {
  if (!status) {
    return "Loading...";
  }
  if (!status.supported) {
    return "Unsupported";
  }
  return displayVersion(status.installedVersion) ?? "Not installed";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

function installPhaseLabel(progress: VscodeInstallProgress): string {
  switch (progress.phase) {
    case "preparing":
      return "Preparing install";
    case "downloading":
      return "Downloading runtime";
    case "extracting":
      return "Extracting runtime";
    case "cleaning":
      return "Cleaning old runtimes";
    case "starting":
      return "Starting service";
    default:
      return "Installing";
  }
}

function installPhaseDescription(
  progress: VscodeInstallProgress,
  runtime: VscodeRuntimeKind,
): string {
  const meta = RUNTIME_META[runtime];
  if (
    progress.phase === "downloading" &&
    typeof progress.downloadedBytes === "number" &&
    typeof progress.totalBytes === "number"
  ) {
    return `Downloading ${meta.downloadLabel} ${progress.percent}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)})`;
  }

  if (
    progress.phase === "downloading" &&
    typeof progress.downloadedBytes === "number"
  ) {
    return `Downloading ${meta.downloadLabel} (${formatBytes(progress.downloadedBytes)})`;
  }

  switch (progress.phase) {
    case "preparing":
      return `Preparing ${meta.downloadLabel} download and runtime paths.`;
    case "extracting":
      return `Extracting the standalone ${meta.downloadLabel} archive.`;
    case "cleaning":
      return "Removing older runtimes for this host platform.";
    case "starting":
      return `Launching ${meta.downloadLabel} and waiting for it to become ready.`;
    default:
      return `Installing ${meta.downloadLabel}.`;
  }
}

function runtimeStatus(
  status: VscodeStatus | null,
  runtime: VscodeRuntimeKind,
): VscodeRuntimeStatus | null {
  if (!status) {
    return null;
  }
  return runtime === "codeServer" ? status.codeServer : status.vscodeCli;
}

function taskStepLabel(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export default function VscodeSettings() {
  const status = useVscodeStore((state) => state.status);
  const tasksById = useTaskStore((state) => state.tasksById);
  const selectedRuntimeSetting = useSettingsStore(
    (state) => state.settings.vscode.runtime,
  );
  const updateVscodeSettings = useSettingsStore((state) => state.updateVscode);
  const [pendingAction, setPendingAction] = useState<ActionKind>(null);

  const selectedRuntime = selectedRuntimeSetting ?? "vscodeCli";
  const activeStatus = runtimeStatus(status, selectedRuntime);
  const activeTask = activeStatus?.activeTaskId
    ? (tasksById[activeStatus.activeTaskId] ?? null)
    : null;
  const activeTaskStep =
    activeTask?.steps.find(
      (step) => step.state === "running" || step.state === "rollingBack",
    ) ?? null;
  const latest = activeStatus?.latest ?? null;
  const installProgress = activeTask
    ? null
    : (activeStatus?.installProgress ?? null);
  const processStatus = activeStatus?.processStatus ?? "stopped";
  const busy =
    pendingAction !== null ||
    activeTask?.status === "pending" ||
    activeTask?.status === "running" ||
    activeTask?.status === "rollingBack" ||
    processStatus === "starting" ||
    processStatus === "stopping" ||
    processStatus === "installing";
  const canInstall = activeStatus?.supported && !activeStatus.installedVersion;
  const canStart =
    activeStatus?.supported &&
    !!activeStatus.installedVersion &&
    (processStatus === "stopped" || processStatus === "error");
  const canStop = activeStatus?.supported && processStatus === "running";
  const canRestart = activeStatus?.supported && processStatus === "running";
  const canUpgrade =
    activeStatus?.supported &&
    !!activeStatus.installedVersion &&
    !!latest?.updateAvailable &&
    !!latest.latestVersion;
  const canReinstall =
    activeStatus?.supported && !!activeStatus.installedVersion;
  const runtimeMeta = RUNTIME_META[selectedRuntime];

  async function runAction(
    action: Exclude<ActionKind, null>,
    request: () => Promise<VscodeStatus>,
    successMessage?: string,
  ) {
    setPendingAction(action);
    try {
      const nextStatus = await request();
      setVscodeStatus(nextStatus);
      if (successMessage) {
        toast.success(successMessage);
      }
    } catch (error) {
      toast.error("VS Code action failed", {
        description:
          error instanceof Error ? error.message : "Unexpected error.",
      });
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Hubris keeps <code>/code</code> stable while managing either supported
        runtime.
      </p>

      <div className="space-y-3">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Package className="h-4 w-4 text-muted-foreground" />
          Runtime
        </h4>

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Managed by
          </Label>
          <div className="max-w-sm">
            <Select
              value={selectedRuntime}
              onValueChange={(value: VscodeRuntimeKind) =>
                updateVscodeSettings({ runtime: value })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vscodeCli">Official VS Code CLI</SelectItem>
                <SelectItem value="codeServer">coder/code-server</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Installed
          </Label>
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            {(["vscodeCli", "codeServer"] as const).map((runtime) => (
              <Badge
                key={runtime}
                variant={runtime === selectedRuntime ? "secondary" : "outline"}
              >
                {RUNTIME_META[runtime].label}:{" "}
                {statusSummary(runtimeStatus(status, runtime))}
              </Badge>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Package className="h-4 w-4 text-muted-foreground" />
          Installation
        </h4>

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Selected
          </Label>
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            <Badge
              variant={activeStatus?.installedVersion ? "secondary" : "outline"}
            >
              {statusSummary(activeStatus)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {runtimeMeta.managedBy}
            </span>
          </div>
        </div>

        {activeTask ? (
          <div className={settingsRowClass}>
            <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
              Task
            </Label>
            <div className="flex min-h-8 flex-col gap-2 py-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium">
                  {activeTaskStep
                    ? taskStepLabel(activeTaskStep.name)
                    : activeTask.title}
                </span>
                <span className="text-muted-foreground">
                  {activeTask.progressPercent}%
                </span>
              </div>
              <Progress
                value={activeTask.progressPercent}
                aria-label="Task progress"
              />
              <p className="text-xs text-muted-foreground">
                {activeTask.statusText ??
                  (activeTaskStep
                    ? `${taskStepLabel(activeTaskStep.name)} in progress.`
                    : activeTask.title)}
              </p>
            </div>
          </div>
        ) : installProgress ? (
          <div className={settingsRowClass}>
            <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
              Install
            </Label>
            <div className="flex min-h-8 flex-col gap-2 py-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="font-medium">
                  {installPhaseLabel(installProgress)}
                </span>
                <span className="text-muted-foreground">
                  {installProgress.percent}%
                </span>
              </div>
              <Progress
                value={installProgress.percent}
                aria-label="Install progress"
              />
              <p className="text-xs text-muted-foreground">
                {installPhaseDescription(installProgress, selectedRuntime)}
              </p>
            </div>
          </div>
        ) : null}

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Latest
          </Label>
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            <Badge variant={latest?.latestVersion ? "secondary" : "outline"}>
              {displayVersion(latest?.latestVersion) ?? "Not checked yet"}
            </Badge>
            {latest?.updateAvailable ? (
              <span className="text-xs text-muted-foreground">
                New {runtimeMeta.label} release available
              </span>
            ) : latest?.latestVersion && activeStatus?.installedVersion ? (
              <span className="text-xs text-muted-foreground">
                {runtimeMeta.label} is up to date
              </span>
            ) : null}
          </div>
        </div>

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Actions
          </Label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!activeStatus?.supported || busy}
              onClick={() =>
                void runAction(
                  "check",
                  checkVscodeUpdate,
                  `Checked ${runtimeMeta.label} for updates`,
                )
              }
            >
              {pendingAction === "check" ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <RefreshCw data-icon="inline-start" />
              )}
              Check for Update
            </Button>

            {canInstall ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    "install",
                    () => installVscode(),
                    `Started ${runtimeMeta.label} install`,
                  )
                }
              >
                {pendingAction === "install" ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Download data-icon="inline-start" />
                )}
                Install latest
              </Button>
            ) : null}

            {canUpgrade ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    "upgrade",
                    () => installVscode(latest?.latestVersion ?? undefined),
                    `Started ${runtimeMeta.label} upgrade to ${displayVersion(latest?.latestVersion)}`,
                  )
                }
              >
                {pendingAction === "upgrade" ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Download data-icon="inline-start" />
                )}
                Upgrade to {displayVersion(latest?.latestVersion)}
              </Button>
            ) : null}

            {canReinstall ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    "reinstall",
                    () =>
                      installVscode(
                        activeStatus?.installedVersion ?? undefined,
                        true,
                      ),
                    `Started ${runtimeMeta.label} reinstall`,
                  )
                }
              >
                {pendingAction === "reinstall" ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Download data-icon="inline-start" />
                )}
                Reinstall
              </Button>
            ) : null}

            {activeStatus && !activeStatus.supported ? (
              <Button variant="ghost" size="sm" disabled>
                <CircleOff data-icon="inline-start" />
                Unsupported host
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Process
        </h4>

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Status
          </Label>
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant(processStatus)}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {statusLabel(processStatus)}
            </Badge>
            {activeStatus?.message ? (
              <span className="text-xs text-muted-foreground">
                {activeStatus.message}
              </span>
            ) : processStatus === "running" ? (
              <span className="text-xs text-muted-foreground">
                {runtimeMeta.readyLabel}
              </span>
            ) : null}
          </div>
        </div>

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Actions
          </Label>
          <div className="flex flex-wrap gap-2">
            {canStart ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    "start",
                    startVscode,
                    `Started ${runtimeMeta.label}`,
                  )
                }
              >
                {pendingAction === "start" ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                Start
              </Button>
            ) : null}

            {canStop ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    "stop",
                    stopVscode,
                    `Stopped ${runtimeMeta.label}`,
                  )
                }
              >
                {pendingAction === "stop" ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <Square data-icon="inline-start" />
                )}
                Stop
              </Button>
            ) : null}

            {canRestart ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void runAction(
                    "restart",
                    restartVscode,
                    `Restarted ${runtimeMeta.label}`,
                  )
                }
              >
                {pendingAction === "restart" ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : (
                  <RotateCcw data-icon="inline-start" />
                )}
                Restart
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
