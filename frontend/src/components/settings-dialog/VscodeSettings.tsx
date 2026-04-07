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
  checkCodeServerUpdate,
  installCodeServer,
  restartCodeServer,
  startCodeServer,
  stopCodeServer,
  type CodeServerInstallProgress,
  type CodeServerStatus,
} from "@/lib/api";
import {
  setCodeServerStatus,
  useCodeServerStore,
} from "@/lib/stores/codeServer";

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

function statusBadgeVariant(status: CodeServerStatus["processStatus"]) {
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

function statusLabel(status: CodeServerStatus["processStatus"]) {
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

function statusSummary(status: CodeServerStatus | null): string {
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

function installPhaseLabel(progress: CodeServerInstallProgress): string {
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

function installPhaseDescription(progress: CodeServerInstallProgress): string {
  if (
    progress.phase === "downloading" &&
    typeof progress.downloadedBytes === "number" &&
    typeof progress.totalBytes === "number"
  ) {
    return `Downloading coder/code-server ${progress.percent}% (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)})`;
  }

  if (
    progress.phase === "downloading" &&
    typeof progress.downloadedBytes === "number"
  ) {
    return `Downloading coder/code-server (${formatBytes(progress.downloadedBytes)})`;
  }

  switch (progress.phase) {
    case "preparing":
      return "Preparing coder/code-server download and runtime paths.";
    case "extracting":
      return "Extracting the standalone coder/code-server archive.";
    case "cleaning":
      return "Removing older runtimes for this host platform.";
    case "starting":
      return "Launching coder/code-server and waiting for it to become ready.";
    default:
      return "Installing coder/code-server.";
  }
}

export default function VscodeSettings() {
  const status = useCodeServerStore((state) => state.status);
  const [pendingAction, setPendingAction] = useState<ActionKind>(null);

  async function runAction(
    action: Exclude<ActionKind, null>,
    request: () => Promise<CodeServerStatus>,
    successMessage?: string,
  ) {
    setPendingAction(action);
    try {
      const nextStatus = await request();
      setCodeServerStatus(nextStatus);
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

  const processStatus = status?.processStatus ?? "stopped";
  const latest = status?.latest;
  const installProgress = status?.installProgress ?? null;
  const busy =
    pendingAction !== null ||
    processStatus === "starting" ||
    processStatus === "stopping" ||
    processStatus === "installing";
  const canInstall = status?.supported && !status.installedVersion;
  const canStart =
    status?.supported &&
    !!status.installedVersion &&
    (processStatus === "stopped" || processStatus === "error");
  const canStop = status?.supported && processStatus === "running";
  const canRestart = status?.supported && processStatus === "running";
  const canUpgrade =
    status?.supported &&
    !!status.installedVersion &&
    !!latest?.updateAvailable &&
    !!latest.latestVersion;
  const canReinstall = status?.supported && !!status.installedVersion;

  return (
    <section className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Managed by <code>coder/code-server</code>
      </p>

      <div className="space-y-3">
        <h4 className="flex items-center gap-2 text-sm font-medium">
          <Package className="h-4 w-4 text-muted-foreground" />
          Installation
        </h4>

        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Installed
          </Label>
          <div className="flex min-h-8 flex-wrap items-center gap-2">
            <Badge variant={status?.installedVersion ? "secondary" : "outline"}>
              {statusSummary(status)}
            </Badge>
            {status?.installedVersion ? (
              <span className="text-xs text-muted-foreground">
                coder/code-server runtime
              </span>
            ) : null}
          </div>
        </div>

        {installProgress ? (
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
                {installPhaseDescription(installProgress)}
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
                New coder/code-server release available
              </span>
            ) : latest?.latestVersion && status?.installedVersion ? (
              <span className="text-xs text-muted-foreground">
                coder/code-server is up to date
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
              disabled={!status?.supported || busy}
              onClick={() =>
                void runAction(
                  "check",
                  checkCodeServerUpdate,
                  "Checked coder/code-server for updates",
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
                    () => installCodeServer(),
                    "Started coder/code-server install",
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
                    () => installCodeServer(latest?.latestVersion ?? undefined),
                    `Started coder/code-server upgrade to ${displayVersion(latest?.latestVersion)}`,
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
                      installCodeServer(
                        status.installedVersion ?? undefined,
                        true,
                      ),
                    "Started coder/code-server reinstall",
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

            {status && !status.supported ? (
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
            {status?.message ? (
              <span className="text-xs text-muted-foreground">
                {status.message}
              </span>
            ) : processStatus === "running" ? (
              <span className="text-xs text-muted-foreground">
                coder/code-server is ready for <code>/code</code>.
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
                    startCodeServer,
                    "Started coder/code-server",
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
                    stopCodeServer,
                    "Stopped coder/code-server",
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
                    restartCodeServer,
                    "Restarted coder/code-server",
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
