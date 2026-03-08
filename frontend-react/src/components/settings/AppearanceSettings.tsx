import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useThemeStore } from "@/lib/stores/theme";
import { ThemeSelect } from "@/components/ThemeSelect";
import { Sun, Moon, Monitor } from "lucide-react";

export function AppearanceSettings() {
  const settings = useThemeStore((s) => s.settings);
  const allThemes = useThemeStore((s) => s.allThemes);
  const updateSettings = useThemeStore((s) => s.updateSettings);

  const lightThemes = allThemes.filter((t) => t.type === "light");
  const darkThemes = allThemes.filter((t) => t.type === "dark");
  const isFixedLight = settings.colorScheme === "light";
  const fixedThemes = isFixedLight ? lightThemes : darkThemes;
  const fixedCurrent = isFixedLight ? settings.lightTheme : settings.darkTheme;

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Color Scheme</h3>
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <Label>Mode</Label>
        <div className="flex gap-1">
          <Button
            variant={settings.colorScheme === "light" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => updateSettings({ colorScheme: "light" })}
          >
            <Sun className="mr-1.5 h-3.5 w-3.5" />
            Light
          </Button>
          <Button
            variant={settings.colorScheme === "dark" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => updateSettings({ colorScheme: "dark" })}
          >
            <Moon className="mr-1.5 h-3.5 w-3.5" />
            Dark
          </Button>
          <Button
            variant={settings.colorScheme === "auto" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => updateSettings({ colorScheme: "auto" })}
          >
            <Monitor className="mr-1.5 h-3.5 w-3.5" />
            Auto
          </Button>
        </div>
      </div>

      {settings.colorScheme === "auto" ? (
        <>
          <ThemeSelect
            label="Light Theme"
            themes={lightThemes}
            value={settings.lightTheme}
            onChange={(v) => updateSettings({ lightTheme: v })}
          />
          <ThemeSelect
            label="Dark Theme"
            themes={darkThemes}
            value={settings.darkTheme}
            onChange={(v) => updateSettings({ darkTheme: v })}
          />
        </>
      ) : (
        <ThemeSelect
          label="Theme"
          themes={fixedThemes}
          value={fixedCurrent}
          onChange={(v) =>
            updateSettings(isFixedLight ? { lightTheme: v } : { darkTheme: v })
          }
        />
      )}
    </section>
  );
}
