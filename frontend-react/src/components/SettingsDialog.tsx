import { useMemo, useState } from "react";
import {
  GitFork,
  Minus,
  Monitor,
  Moon,
  Paintbrush,
  Plus,
  Sun,
  Type,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useThemeStore, themeEntries } from "$lib/stores/theme";
import { BUNDLED_FONTS } from "$lib/terminal/fonts";
import { useTerminalStore } from "$lib/stores/terminal";
import { useWorktreeSettingsStore } from "$lib/stores/worktreeSettings";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const sections = [
  { name: "Appearance", icon: Paintbrush },
  { name: "Terminal", icon: Monitor },
  { name: "Worktrees", icon: GitFork },
] as const;

type SectionName = (typeof sections)[number]["name"];

export default function SettingsDialog({ open, onOpenChange }: Props) {
  const [activeSection, setActiveSection] = useState<SectionName>("Appearance");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your settings here.
        </DialogDescription>
        <div className="flex h-[480px] overflow-hidden">
          <aside className="hidden w-56 shrink-0 border-r md:flex md:flex-col">
            <div className="flex h-12 items-center border-b px-4">
              <h2 className="text-base font-semibold">Settings</h2>
            </div>
            <div className="flex-1 p-2">
              {sections.map((item) => (
                <Button
                  key={item.name}
                  variant={activeSection === item.name ? "secondary" : "ghost"}
                  className="mb-1 w-full justify-start"
                  onClick={() => setActiveSection(item.name)}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.name}</span>
                </Button>
              ))}
            </div>
          </aside>
          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <Breadcrumb className="hidden md:block">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{activeSection}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <div className="flex-1 md:hidden">
                <Select
                  value={activeSection}
                  onValueChange={(value) =>
                    setActiveSection(value as SectionName)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sections.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {activeSection === "Appearance" ? <AppearanceSettings /> : null}
              {activeSection === "Terminal" ? <TerminalSettings /> : null}
              {activeSection === "Worktrees" ? <WorktreeSettings /> : null}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppearanceSettings() {
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

function ThemeSelect({
  label,
  themes,
  value,
  onChange,
}: {
  label: string;
  themes: ReturnType<typeof themeEntries>;
  value: string;
  onChange: (value: string) => void;
}) {
  const selectedName =
    themes.find((theme) => theme.id === value)?.name ?? "Select…";

  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
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
    </div>
  );
}

function TerminalSettings() {
  const settings = useTerminalStore((state) => state.settings);
  const fontFamily = useTerminalStore((state) => state.fontFamily);
  const updateSettings = useTerminalStore((state) => state.updateSettings);

  const fontPreviewLines = [
    "Hello, World!",
    "ABCDEFGHIJKLM 0123456789",
    "abcdefghijklm ~!@#$%^&*()",
  ];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Font</h3>
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <Label>Source</Label>
        <div className="flex gap-1">
          <Button
            variant={settings.fontSource === "default" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => void updateSettings({ fontSource: "default" })}
          >
            Default
          </Button>
          <Button
            variant={settings.fontSource === "system" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => void updateSettings({ fontSource: "system" })}
          >
            System
          </Button>
          <Button
            variant={settings.fontSource === "bundled" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => void updateSettings({ fontSource: "bundled" })}
          >
            <Type className="mr-1.5 h-3.5 w-3.5" />
            Bundled
          </Button>
        </div>
      </div>

      {settings.fontSource === "system" ? (
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label>Font Family</Label>
          <Input
            type="text"
            placeholder="'My Font', monospace"
            value={settings.systemFontFamily}
            onChange={(event) =>
              void updateSettings({
                systemFontFamily: event.currentTarget.value,
              })
            }
          />
        </div>
      ) : null}

      {settings.fontSource === "bundled" ? (
        <div className="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label>Bundled Font</Label>
          <Select
            value={settings.bundledFont}
            onValueChange={(value) =>
              void updateSettings({ bundledFont: value })
            }
          >
            <SelectTrigger className="w-full">
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

      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <Label>Font Size</Label>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            disabled={settings.fontSize <= 8}
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
            onChange={(event) =>
              void updateSettings({
                fontSize: Number.parseInt(event.currentTarget.value, 10) || 14,
              })
            }
            className="h-8 w-14 text-center"
          />
          <Button
            variant="outline"
            size="icon-sm"
            disabled={settings.fontSize >= 32}
            onClick={() =>
              void updateSettings({ fontSize: settings.fontSize + 1 })
            }
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

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

function WorktreeSettings() {
  const settings = useWorktreeSettingsStore((state) => state.settings);
  const updateSettings = useWorktreeSettingsStore(
    (state) => state.updateSettings,
  );

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Location</h3>
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <Label>Mode</Label>
        <div className="flex gap-1">
          <Button
            variant={
              settings.locationMode === "dataDir" ? "secondary" : "ghost"
            }
            size="sm"
            onClick={() => void updateSettings({ locationMode: "dataDir" })}
          >
            Data Dir
          </Button>
          <Button
            variant={
              settings.locationMode === "repoLocalDotHubris"
                ? "secondary"
                : "ghost"
            }
            size="sm"
            onClick={() =>
              void updateSettings({ locationMode: "repoLocalDotHubris" })
            }
          >
            Repo .hubris
          </Button>
        </div>
      </div>
    </section>
  );
}
