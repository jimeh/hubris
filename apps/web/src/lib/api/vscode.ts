import type { components } from "@/lib/contracts/rest.generated";
import { requestJson } from "./client";

export type VscodeLatestCheck = components["schemas"]["VscodeLatestCheck"];
export type VscodeInstallPhase = components["schemas"]["VscodeInstallPhase"];
export type VscodeInstallProgress =
  components["schemas"]["VscodeInstallProgress"];
export type VscodeProcessStatus = components["schemas"]["VscodeProcessStatus"];
export type VscodeRuntimeStatus = components["schemas"]["VscodeRuntimeStatus"];
export type VscodeStatus = components["schemas"]["VscodeStatus"];
export type VscodeConnectionInfo =
  components["schemas"]["VscodeConnectionInfo"];

export async function getVscodeStatus(): Promise<VscodeStatus> {
  return requestJson("GET", "/api/vscode", {});
}

export async function checkVscodeUpdate(): Promise<VscodeStatus> {
  return requestJson("POST", "/api/vscode/check-update", {});
}

export async function installVscode(
  version?: string,
  force = false,
): Promise<VscodeStatus> {
  return requestJson("POST", "/api/vscode/install", {
    body: {
      ...(version ? { version } : {}),
      ...(force ? { force } : {}),
    },
  });
}

export async function startVscode(): Promise<VscodeStatus> {
  return requestJson("POST", "/api/vscode/start", {});
}

export async function stopVscode(): Promise<VscodeStatus> {
  return requestJson("POST", "/api/vscode/stop", {});
}

export async function restartVscode(): Promise<VscodeStatus> {
  return requestJson("POST", "/api/vscode/restart", {});
}
