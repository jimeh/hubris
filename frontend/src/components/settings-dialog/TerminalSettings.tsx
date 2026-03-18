import { Minus, Plus, Terminal, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettingsStore } from "@/lib/stores/settings";
import { useTerminalSettings } from "@/lib/stores/terminal";
import { BUNDLED_FONTS } from "@/lib/terminal/fonts";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center sm:gap-3";

export default function TerminalSettings() {
  const settings = useTerminalSettings((state) => state.settings);
  const fontFamily = useTerminalSettings((state) => state.fontFamily);
  const updateSettings = useTerminalSettings((state) => state.updateSettings);
  const writesBlocked = useSettingsStore((state) => state.status.writesBlocked);

  const fontPreviewLines = [
    "Hello, World!",
    "ABCDEFGHIJKLM 0123456789",
    "abcdefghijklm ~!@#$%^&*()",
  ];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Font</h3>
      </div>
      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Source
        </Label>
        <div className="flex flex-wrap gap-1">
          <Button
            variant={settings.fontSource === "default" ? "secondary" : "ghost"}
            size="sm"
            disabled={writesBlocked}
            onClick={() => void updateSettings({ fontSource: "default" })}
          >
            Default
          </Button>
          <Button
            variant={settings.fontSource === "system" ? "secondary" : "ghost"}
            size="sm"
            disabled={writesBlocked}
            onClick={() => void updateSettings({ fontSource: "system" })}
          >
            System
          </Button>
          <Button
            variant={settings.fontSource === "bundled" ? "secondary" : "ghost"}
            size="sm"
            disabled={writesBlocked}
            onClick={() => void updateSettings({ fontSource: "bundled" })}
          >
            <Type className="mr-1.5 h-3.5 w-3.5" />
            Bundled
          </Button>
        </div>
      </div>

      {settings.fontSource === "system" ? (
        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Font Family
          </Label>
          <Input
            type="text"
            placeholder="'My Font', monospace"
            value={settings.systemFontFamily}
            disabled={writesBlocked}
            onChange={(event) =>
              void updateSettings(
                {
                  systemFontFamily: event.currentTarget.value,
                },
                {
                  debounceKey: "terminal.systemFontFamily",
                },
              )
            }
          />
        </div>
      ) : null}

      {settings.fontSource === "bundled" ? (
        <div className={settingsRowClass}>
          <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
            Bundled Font
          </Label>
          <Select
            value={settings.bundledFont}
            disabled={writesBlocked}
            onValueChange={(value) =>
              void updateSettings({ bundledFont: value })
            }
          >
            <SelectTrigger className="w-full" disabled={writesBlocked}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BUNDLED_FONTS.map((font) => (
                <SelectItem key={font.id} value={font.id}>
                  {font.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Font Size
        </Label>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={writesBlocked || settings.fontSize <= 8}
            onClick={() =>
              void updateSettings({ fontSize: settings.fontSize - 1 })
            }
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Input
            type="text"
            inputMode="numeric"
            value={String(settings.fontSize)}
            disabled={writesBlocked}
            onChange={(event) =>
              void updateSettings(
                {
                  fontSize:
                    Number.parseInt(event.currentTarget.value, 10) || 14,
                },
                {
                  debounceKey: "terminal.fontSize",
                },
              )
            }
            className="h-8 w-14 text-center"
          />
          <Button
            variant="outline"
            size="icon-sm"
            disabled={writesBlocked || settings.fontSize >= 32}
            onClick={() =>
              void updateSettings({ fontSize: settings.fontSize + 1 })
            }
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-start sm:gap-3">
        <Label className="text-xs font-medium text-muted-foreground sm:pt-2 sm:text-sm">
          Preview
        </Label>
        <div
          className="overflow-hidden rounded-md border"
          style={{
            backgroundColor: "var(--terminal-background)",
            color: "var(--terminal-foreground)",
          }}
        >
          <pre
            className="m-0 overflow-hidden p-3 leading-normal"
            style={{
              fontFamily,
              fontSize: `${settings.fontSize}px`,
            }}
          >
            <span style={{ color: "var(--terminal-ansi-green)" }}>$</span> echo
            "Hello, World!"
            {"\n"}
            {fontPreviewLines.join("\n")}
          </pre>
        </div>
      </div>
    </section>
  );
}
