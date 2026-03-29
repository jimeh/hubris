import { useCallback, useEffect, useRef, useState } from "react";
import { Code2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsStore } from "@/lib/stores/settings";
import { useThemeSettings } from "@/lib/stores/theme";
import { useEditorThemeSettings } from "@/lib/stores/editorTheme";
import {
  deleteEditorTheme,
  listEditorThemes,
  uploadEditorTheme,
  type EditorThemeEntry,
  type VscodeThemeJson,
} from "@/lib/api";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center sm:gap-3";

export default function EditorSettings() {
  const colorScheme = useThemeSettings((state) => state.settings.colorScheme);
  const editorSettings = useEditorThemeSettings((state) => state.settings);
  const updateEditor = useEditorThemeSettings((state) => state.updateSettings);
  const writesBlocked = useSettingsStore((state) => state.status.writesBlocked);

  const [themes, setThemes] = useState<EditorThemeEntry[]>([]);
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
        try {
          const parsed = JSON.parse(reader.result as string) as VscodeThemeJson;
          if (
            !parsed.tokenColors?.length &&
            !Object.keys(parsed.colors ?? {}).length
          ) {
            return;
          }
          void uploadEditorTheme(parsed).then((entry) => {
            refreshThemes();
            const isLight = entry.type === "light";
            updateEditor(
              isLight
                ? { lightEditorTheme: entry.id }
                : { darkEditorTheme: entry.id },
            );
          });
        } catch {
          // Invalid JSON — silently ignore.
        }
      };
      reader.readAsText(file);
      // Reset so the same file can be re-selected.
      e.target.value = "";
    },
    [refreshThemes, updateEditor],
  );

  const handleDelete = useCallback(
    (id: string) => {
      void deleteEditorTheme(id).then(() => {
        refreshThemes();
        // Fall back to built-in if the deleted theme was selected.
        if (editorSettings.lightEditorTheme === id) {
          updateEditor({ lightEditorTheme: "hubris-light" });
        }
        if (editorSettings.darkEditorTheme === id) {
          updateEditor({ darkEditorTheme: "hubris-dark" });
        }
      });
    },
    [
      refreshThemes,
      updateEditor,
      editorSettings.lightEditorTheme,
      editorSettings.darkEditorTheme,
    ],
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

      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Custom
        </Label>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={writesBlocked}
            onClick={handleImport}
          >
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Import Theme
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
          <span className="text-xs text-muted-foreground">VS Code .json</span>
        </div>
      </div>
    </section>
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
