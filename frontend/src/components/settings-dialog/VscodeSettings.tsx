import { useState } from "react";
import {
  CircleOff,
  Download,
  Loader2,
  Monitor,
  RefreshCw,
  RotateCcw,
  Square,
  TriangleRight,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
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

function statusSummary(status: CodeServerStatus | null): string {
  if (!status) {
    return "Loading...";
  }
  if (!status.supported) {
    return "Unsupported";
  }
  return status.installedVersion ?? "Not installed";
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

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2">
        <Monitor className="h-4 w-4 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">VS Code</h3>
          <p className="text-xs text-muted-foreground">
            Managed by <code>coder/code-server</code>
          </p>
        </div>
      </div>

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

      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Process
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
          <Badge variant="outline">
            {latest?.latestVersion
              ? `v${latest.latestVersion}`
              : "Not checked yet"}
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

      <Separator />

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
                  `Started coder/code-server upgrade to v${latest?.latestVersion}`,
                )
              }
            >
              {pendingAction === "upgrade" ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : (
                <Download data-icon="inline-start" />
              )}
              Upgrade to v{latest?.latestVersion}
            </Button>
          ) : null}

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
                <TriangleRight data-icon="inline-start" />
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

          {status && !status.supported ? (
            <Button variant="ghost" size="sm" disabled>
              <CircleOff data-icon="inline-start" />
              Unsupported host
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
