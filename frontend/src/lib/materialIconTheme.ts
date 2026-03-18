import type { HubrisTheme } from "@/lib/theme/types";
import { materialIconThemeData } from "@/lib/materialIconTheme.generated";

type ThemeVariant = "default" | "light";

type ResolvedMaterialIcon = {
  iconPath: string;
  iconId: string;
};

type MaterialIconThemeData = {
  iconPaths: Record<string, string>;
  defaults: {
    file: string;
    folder: string;
    folderExpanded: string;
  };
  associations: {
    fileNames: Record<string, string>;
    fileExtensions: Record<string, string>;
    folderNames: Record<string, string>;
    folderNamesExpanded: Record<string, string>;
    light: {
      fileNames: Record<string, string>;
      fileExtensions: Record<string, string>;
      folderNames: Record<string, string>;
      folderNamesExpanded: Record<string, string>;
    };
  };
};

type ManifestAssociations = MaterialIconThemeData["associations"];
type AssociationField = keyof ManifestAssociations["light"];

const themeData = materialIconThemeData as MaterialIconThemeData;

function themeVariant(theme: HubrisTheme | null): ThemeVariant {
  return theme?.type === "light" ? "light" : "default";
}

function iconPathFromId(iconId: string): string | null {
  return themeData.iconPaths[iconId] ?? null;
}

function associationValue(
  variant: ThemeVariant,
  field: AssociationField,
  key: string,
): string | null {
  const lightAssociations =
    variant === "light" ? themeData.associations.light[field] : undefined;
  return lightAssociations?.[key] ?? themeData.associations[field][key] ?? null;
}

function extensionCandidates(name: string): string[] {
  const lowerName = name.toLowerCase();
  const segments = lowerName.split(".");
  if (segments.length < 2) {
    return [];
  }

  const candidates: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const suffix = segments.slice(index).join(".");
    if (suffix) {
      candidates.push(suffix);
    }
  }

  return candidates;
}

function resolveIcon(
  iconId: string | null,
  fallbackIconId: string,
): ResolvedMaterialIcon {
  const resolvedId = iconId ?? fallbackIconId;
  const iconPath = iconPathFromId(resolvedId) ?? iconPathFromId(fallbackIconId);
  if (!iconPath) {
    throw new Error(`Material icon path missing for icon id: ${resolvedId}`);
  }

  return {
    iconId: resolvedId,
    iconPath,
  };
}

export function resolveMaterialFileIcon(
  path: string,
  theme: HubrisTheme | null,
): ResolvedMaterialIcon {
  const fallbackIconId = themeData.defaults.file;
  const variant = themeVariant(theme);
  const name =
    path.split("/").filter(Boolean).pop()?.toLowerCase() ?? path.toLowerCase();

  const fileNameMatch = associationValue(variant, "fileNames", name);
  if (fileNameMatch) {
    return resolveIcon(fileNameMatch, fallbackIconId);
  }

  for (const candidate of extensionCandidates(name)) {
    const fileExtensionMatch = associationValue(
      variant,
      "fileExtensions",
      candidate,
    );
    if (fileExtensionMatch) {
      return resolveIcon(fileExtensionMatch, fallbackIconId);
    }
  }

  return resolveIcon(null, fallbackIconId);
}

export function resolveMaterialFolderIcon(
  name: string,
  theme: HubrisTheme | null,
  expanded: boolean,
): ResolvedMaterialIcon {
  const variant = themeVariant(theme);
  const normalizedName = name.toLowerCase();
  const associationField = expanded ? "folderNamesExpanded" : "folderNames";
  const fallbackIconId = expanded
    ? themeData.defaults.folderExpanded
    : themeData.defaults.folder;
  const iconId = associationValue(variant, associationField, normalizedName);

  return resolveIcon(iconId, fallbackIconId);
}
