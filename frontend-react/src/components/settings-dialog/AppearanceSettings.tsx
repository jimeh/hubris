import { useMemo } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { themeEntries, useThemeStore } from "$lib/stores/theme";
import ThemeSelect from "./ThemeSelect";

export default function AppearanceSettings() {
  const settings = useThemeStore((state) => state.settings);
  const updateSettings = useThemeStore((state) => state.updateSettings);
  const allThemes = useMemo(() => themeEntries(), []);

  const lightThemes = allThemes.filter((theme) => theme.type === "light");
  const darkThemes = allThemes.filter((theme) => theme.type === "dark");
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
            onClick={() => void updateSettings({ colorScheme: "light" })}
          >
            <Sun className="mr-1.5 h-3.5 w-3.5" />
            Light
          </Button>
          <Button
            variant={settings.colorScheme === "dark" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => void updateSettings({ colorScheme: "dark" })}
          >
            <Moon className="mr-1.5 h-3.5 w-3.5" />
            Dark
          </Button>
          <Button
            variant={settings.colorScheme === "auto" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => void updateSettings({ colorScheme: "auto" })}
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
            onChange={(value) => void updateSettings({ lightTheme: value })}
          />
          <ThemeSelect
            label="Dark Theme"
            themes={darkThemes}
            value={settings.darkTheme}
            onChange={(value) => void updateSettings({ darkTheme: value })}
          />
        </>
      ) : (
        <ThemeSelect
          label="Theme"
          themes={fixedThemes}
          value={fixedCurrent}
          onChange={(value) =>
            void updateSettings(
              isFixedLight ? { lightTheme: value } : { darkTheme: value },
            )
          }
        />
      )}
    </section>
  );
}
