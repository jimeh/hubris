import type { ListFilesResponse } from "@/lib/types";
import { requestJson } from "./client";

export async function listFiles(
  path?: string,
  showHidden = false,
): Promise<ListFilesResponse> {
  return requestJson("GET", "/api/files", {
    query: {
      ...(path ? { path } : {}),
      ...(showHidden ? { showHidden: true } : {}),
    },
  });
}
