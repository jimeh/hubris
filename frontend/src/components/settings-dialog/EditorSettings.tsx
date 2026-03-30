import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Code2,
  Download,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useSettingsStore } from "@/lib/stores/settings";
import { useThemeSettings } from "@/lib/stores/theme";
import { useEditorThemeSettings } from "@/lib/stores/editorTheme";
import {
  deleteEditorTheme,
  discoverExtensionThemes,
  importExtensionTheme,
  listEditorThemes,
  uploadEditorTheme,
  type DiscoveredExtension,
  type DiscoveredTheme,
  type EditorThemeEntry,
} from "@/lib/api";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center sm:gap-3";

export default function EditorSettings() {
  const colorScheme = useThemeSettings((state) => state.settings.colorScheme);
  const editorSettings = useEditorThemeSettings((state) => state.settings);
  const updateEditor = useEditorThemeSettings((state) => state.updateSettings);
  const writesBlocked = useSettingsStore((state) => state.status.writesBlocked);

  const [themes, setThemes] = useState<EditorThemeEntry[]>([]);
  const [extensions, setExtensions] = useState<DiscoveredExtension[] | null>(
    null,
  );
  const [discovering, setDiscovering] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshThemes = useCallback(() => {
    void listEditorThemes().then(setThemes);
  }, []);

  useEffect(() => {
    refreshThemes();
  }, [refreshThemes]);

  const lightThemes = themes.filter((t) => t.type === "light");
  const darkThemes = themes.filter((t) => t.type === "dark");
  const isFixedLight = colorScheme === "light";
  const prefersLight = useThemeSettings((state) => state.prefersLight);
  const effectiveLight =
    colorScheme === "light" || (colorScheme === "auto" && prefersLight);

  const handleImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const rawText = reader.result as string;
        void uploadEditorTheme(rawText)
          .then((entry) => {
            refreshThemes();
            const isLight = entry.type === "light";
            updateEditor(
              isLight
                ? { lightEditorTheme: entry.id }
                : { darkEditorTheme: entry.id },
            );
          })
          .catch(() => {
            toast.error("Failed to import theme file");
          });
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [refreshThemes, updateEditor],
  );

  const handleDelete = useCallback(
    (id: string) => {
      void deleteEditorTheme(id)
        .then(() => {
          refreshThemes();
          if (editorSettings.lightEditorTheme === id) {
            updateEditor({ lightEditorTheme: "hubris-light" });
          }
          if (editorSettings.darkEditorTheme === id) {
            updateEditor({ darkEditorTheme: "hubris-dark" });
          }
        })
        .catch(() => {
          toast.error("Failed to delete theme");
        });
    },
    [
      refreshThemes,
      updateEditor,
      editorSettings.lightEditorTheme,
      editorSettings.darkEditorTheme,
    ],
  );

  const handleDiscover = useCallback(() => {
    setDiscovering(true);
    void discoverExtensionThemes()
      .then(setExtensions)
      .finally(() => setDiscovering(false));
  }, []);

  const handleExtensionImport = useCallback(
    (ext: DiscoveredExtension, themeIdx: number, theme: DiscoveredTheme) => {
      const key = `${ext.extensionId}-${themeIdx}`;
      setImporting(key);
      void importExtensionTheme({
        sourceEditor: ext.sourceEditor,
        sourcePath: theme.sourcePath,
        label: theme.label,
        type: theme.type,
        overwriteId: theme.installedId ?? undefined,
      })
        .then((entry) => {
          refreshThemes();
          const isLight = entry.type === "light";
          updateEditor(
            isLight
              ? { lightEditorTheme: entry.id }
              : { darkEditorTheme: entry.id },
          );
          // Refresh discovery to update statuses.
          return discoverExtensionThemes();
        })
        .then(setExtensions)
        .catch(() => {
          toast.error("Failed to import theme");
        })
        .finally(() => setImporting(null));
    },
    [refreshThemes, updateEditor],
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Code2 className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Editor Theme</h3>
      </div>

      {colorScheme === "auto" ? (
        <>
          <EditorThemeSelect
            label="Light Theme"
            themes={lightThemes}
            value={editorSettings.lightEditorTheme}
            disabled={writesBlocked}
            onChange={(v) => updateEditor({ lightEditorTheme: v })}
            onDelete={handleDelete}
          />
          <EditorThemeSelect
            label="Dark Theme"
            themes={darkThemes}
            value={editorSettings.darkEditorTheme}
            disabled={writesBlocked}
            onChange={(v) => updateEditor({ darkEditorTheme: v })}
            onDelete={handleDelete}
          />
        </>
      ) : (
        <EditorThemeSelect
          label="Theme"
          themes={effectiveLight ? lightThemes : darkThemes}
          value={
            effectiveLight
              ? editorSettings.lightEditorTheme
              : editorSettings.darkEditorTheme
          }
          disabled={writesBlocked}
          onChange={(v) =>
            updateEditor(
              isFixedLight ? { lightEditorTheme: v } : { darkEditorTheme: v },
            )
          }
          onDelete={handleDelete}
        />
      )}

      <Separator />

      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Import
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={writesBlocked}
            onClick={handleImport}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            From File
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={writesBlocked || discovering}
            onClick={handleDiscover}
          >
            {discovering ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : extensions !== null ? (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Search className="mr-1.5 h-3.5 w-3.5" />
            )}
            {extensions !== null ? "Refresh" : "From Extensions"}
          </Button>
        </div>
      </div>

      {extensions !== null && (
        <ExtensionList
          extensions={extensions}
          importing={importing}
          disabled={writesBlocked}
          onImport={handleExtensionImport}
        />
      )}
    </section>
  );
}

function ExtensionList({
  extensions,
  importing,
  disabled,
  onImport,
}: {
  extensions: DiscoveredExtension[];
  importing: string | null;
  disabled: boolean;
  onImport: (
    ext: DiscoveredExtension,
    idx: number,
    theme: DiscoveredTheme,
  ) => void;
}) {
  if (extensions.length === 0) {
    return (
      <p className="py-2 text-center text-xs text-muted-foreground">
        No theme extensions found in any installed editor.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {extensions.map((ext) => (
        <div
          key={ext.extensionId}
          className="rounded-md border border-border p-2"
        >
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-xs font-medium">{ext.displayName}</span>
            <Badge variant="outline" className="px-1 py-0 text-[10px]">
              v{ext.version}
            </Badge>
            <span className="text-[10px] text-muted-foreground">
              {ext.sourceEditor}
            </span>
          </div>
          <div className="space-y-1">
            {ext.themes.map((theme, idx) => {
              const key = `${ext.extensionId}-${idx}`;
              const isImporting = importing === key;
              return (
                <div
                  key={key}
                  className="flex items-center gap-2 py-0.5 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">{theme.label}</span>
                  <Badge
                    variant="secondary"
                    className="shrink-0 px-1 py-0 text-[10px]"
                  >
                    {theme.type}
                  </Badge>
                  {theme.installedId && !theme.differs ? (
                    <span className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                      <Check className="h-3 w-3" />
                      Installed
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[10px]"
                      disabled={disabled || isImporting}
                      onClick={() => onImport(ext, idx, theme)}
                    >
                      {isImporting ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <Download className="mr-1 h-3 w-3" />
                      )}
                      {theme.differs ? "Update" : "Import"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function EditorThemeSelect({
  label,
  themes,
  value,
  onChange,
  onDelete,
  disabled = false,
}: {
  label: string;
  themes: EditorThemeEntry[];
  value: string;
  onChange: (value: string) => void;
  onDelete: (id: string) => void;
  disabled?: boolean;
}) {
  const selectedName = themes.find((t) => t.id === value)?.name ?? "Select…";

  return (
    <div className={settingsRowClass}>
      <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
        {label}
      </Label>
      <div className="flex items-center gap-1">
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-full" disabled={disabled}>
            <SelectValue placeholder={selectedName} />
          </SelectTrigger>
          <SelectContent>
            {themes.map((theme) => (
              <SelectItem key={theme.id} value={theme.id}>
                {theme.name}
                {theme.builtin ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    Built-in
                  </span>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!themes.find((t) => t.id === value)?.builtin &&
          themes.find((t) => t.id === value) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              disabled={disabled}
              onClick={() => onDelete(value)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
      </div>
    </div>
  );
}
