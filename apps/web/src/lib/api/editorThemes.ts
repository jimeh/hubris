import { requestJson, requestVoid, type RequestBody } from "./client";

export type VscodeTokenColorSettings = {
  foreground?: string;
  fontStyle?: string;
  background?: string;
};

export type VscodeTokenColor = {
  name?: string;
  scope?: string | string[];
  settings: VscodeTokenColorSettings;
};

export type VscodeThemeJson = {
  name: string;
  type?: string;
  colors: Record<string, string>;
  tokenColors: VscodeTokenColor[];
};

export type EditorThemeEntry = {
  id: string;
  name: string;
  type: string;
  builtin: boolean;
};

export type DiscoveredTheme = {
  label: string;
  type: string;
  sourcePath: string;
  installedId: string | null;
  differs: boolean;
};

export type DiscoveredExtension = {
  extensionId: string;
  displayName: string;
  version: string;
  sourceEditor: string;
  themes: DiscoveredTheme[];
};

export type ImportThemeRequest = {
  sourceEditor: string;
  sourcePath: string;
  label: string;
  type: string;
  overwriteId?: string;
};

export async function listEditorThemes(): Promise<EditorThemeEntry[]> {
  return requestJson("GET", "/api/editor-themes", {});
}

export async function getEditorTheme(id: string): Promise<VscodeThemeJson> {
  return (await requestJson("GET", "/api/editor-themes/{id}", {
    path: { id: encodeURIComponent(id) },
  })) as VscodeThemeJson;
}

export async function uploadEditorTheme(
  rawText: string,
): Promise<EditorThemeEntry> {
  const body = JSON.parse(rawText) as RequestBody<"/api/editor-themes", "post">;
  return requestJson("POST", "/api/editor-themes", {
    body,
    serializedBody: rawText,
  });
}

export async function deleteEditorTheme(id: string): Promise<void> {
  await requestVoid("DELETE", "/api/editor-themes/{id}", {
    path: { id: encodeURIComponent(id) },
  });
}

export async function discoverExtensionThemes(): Promise<
  DiscoveredExtension[]
> {
  return (await requestJson(
    "GET",
    "/api/editor-themes/discover",
    {},
  )) as DiscoveredExtension[];
}

export async function importExtensionTheme(
  req: ImportThemeRequest,
): Promise<EditorThemeEntry> {
  return requestJson("POST", "/api/editor-themes/import", { body: req });
}
