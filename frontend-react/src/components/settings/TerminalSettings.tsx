import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTerminalStore } from "@/lib/stores/terminal";
import { BUNDLED_FONTS } from "@/lib/terminal/fonts";
import { Type, Minus, Plus } from "lucide-react";

const fontPreviewLines = [
  "Hello, World!",
  "ABCDEFGHIJKLM 0123456789",
  "abcdefghijklm ~!@#$%^&*()",
];

export function TerminalSettings() {
  const settings = useTerminalStore((s) => s.settings);
  const fontFamily = useTerminalStore((s) => s.fontFamily);
  const updateSettings = useTerminalStore((s) => s.updateSettings);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Font</h3>

      {/* Font Source */}
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <Label>Source</Label>
        <div className="flex gap-1">
          <Button
            variant={settings.fontSource === "default" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => updateSettings({ fontSource: "default" })}
          >
            Default
          </Button>
          <Button
            variant={settings.fontSource === "system" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => updateSettings({ fontSource: "system" })}
          >
            System
          </Button>
          <Button
            variant={settings.fontSource === "bundled" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => updateSettings({ fontSource: "bundled" })}
          >
            <Type className="mr-1.5 h-3.5 w-3.5" />
            Bundled
          </Button>
        </div>
      </div>

      {/* System font input */}
      {settings.fontSource === "system" && (
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label>Font Family</Label>
          <Input
            type="text"
            placeholder="'My Font', monospace"
            defaultValue={settings.systemFontFamily}
            onChange={(e) =>
              updateSettings({
                systemFontFamily: e.currentTarget.value,
              })
            }
          />
        </div>
      )}

      {/* Bundled font picker */}
      {settings.fontSource === "bundled" && (
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label>Bundled Font</Label>
          <Select
            value={settings.bundledFont}
            onValueChange={(v) => {
              if (v) updateSettings({ bundledFont: v });
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select…" />
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
      )}

      {/* Font Size */}
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <Label>Font Size</Label>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={settings.fontSize <= 8}
            onClick={() =>
              updateSettings({
                fontSize: settings.fontSize - 1,
              })
            }
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Input
            type="text"
            inputMode="numeric"
            value={settings.fontSize}
            onChange={(e) => {
              updateSettings({
                fontSize: parseInt(e.currentTarget.value, 10) || 14,
              });
            }}
            className="h-8 w-14 text-center"
          />
          <Button
            variant="outline"
            size="icon-sm"
            disabled={settings.fontSize >= 32}
            onClick={() =>
              updateSettings({
                fontSize: settings.fontSize + 1,
              })
            }
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Font Preview */}
      <div className="grid grid-cols-[120px_1fr] items-start gap-3">
        <Label className="pt-2">Preview</Label>
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
            <span
              style={{
                color: "var(--terminal-ansi-green)",
              }}
            >
              $
            </span>
            {' echo "Hello, World!"\n'}
            {fontPreviewLines.join("\n")}
          </pre>
        </div>
      </div>
    </section>
  );
}
