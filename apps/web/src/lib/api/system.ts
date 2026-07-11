import type { SystemInfo } from "@/lib/types";
import { requestJson } from "./client";

export async function fetchSystemInfo(): Promise<SystemInfo> {
  return requestJson("GET", "/api/system", {});
}
