import { useCallback, useEffect, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  checkCodeServerUpdate,
  getCodeServerStatus,
  installCodeServer,
  restartCodeServer,
  startCodeServer,
  stopCodeServer,
  type CodeServerStatus,
} from "@/lib/api";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center sm:gap-3";

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

export default function VscodeSettings() {
  const [status, setStatus] = useState<CodeServerStatus | null>(null);
  const [pendingAction, setPendingAction] = useState<ActionKind>(null);

  const loadStatus = useCallback(() => {
    void getCodeServerStatus().then(
      (nextStatus) => {
        setStatus(nextStatus);
      },
      (error: unknown) => {
        toast.error("Failed to load VS Code status", {
          description:
            error instanceof Error ? error.message : "Unexpected error.",
        });
      },
    );
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const runAction = useCallback(
    async (
      action: Exclude<ActionKind, null>,
      request: () => Promise<CodeServerStatus>,
      successMessage?: string,
    ) => {
      setPendingAction(action);
      try {
        const nextStatus = await request();
        setStatus(nextStatus);
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
    },
    [],
  );

  const processStatus = status?.processStatus ?? "stopped";
  const latest = status?.latest;
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
      <div className="flex items-center gap-2">
        <Monitor className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">VS Code</h3>
      </div>

      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Installed
        </Label>
        <div className="flex min-h-8 items-center gap-2">
          <Badge variant={status?.installedVersion ? "secondary" : "outline"}>
            {statusSummary(status)}
          </Badge>
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
          ) : null}
        </div>
      </div>

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
            <span className="text-xs text-amber-600">Update available</span>
          ) : latest?.latestVersion && status?.installedVersion ? (
            <span className="text-xs text-muted-foreground">Up to date</span>
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
                "Checked for update",
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
                  "Installed VS Code",
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
                  `Upgraded to v${latest?.latestVersion}`,
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
                void runAction("start", startCodeServer, "Started VS Code")
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
                void runAction("stop", stopCodeServer, "Stopped VS Code")
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
                  "Restarted VS Code",
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
