<script lang="ts">
  import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { getThemeStore } from "$lib/stores/theme.svelte";
  import { getTerminalStore } from "$lib/stores/terminal.svelte";
  import { getWorktreeSettingsStore } from "$lib/stores/worktreeSettings.svelte";
  import { BUNDLED_FONTS } from "$lib/terminal/fonts";
  import ThemeManager from "./ThemeManager.svelte";
  import ThemeSelect from "./ThemeSelect.svelte";
  import { Sun, Moon, Monitor, Type, Minus, Plus } from "@lucide/svelte";
  import PaintbrushIcon from "@lucide/svelte/icons/paintbrush";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import GitForkIcon from "@lucide/svelte/icons/git-fork";
  import type { Component } from "svelte";

  let {
    open = $bindable(false),
  }: {
    open?: boolean;
  } = $props();

  const theme = getThemeStore();
  const termStore = getTerminalStore();
  const worktreeSettings = getWorktreeSettingsStore();

  const fontPreviewLines = [
    "Hello, World!",
    "ABCDEFGHIJKLM 0123456789",
    "abcdefghijklm ~!@#$%^&*()",
  ];

  type NavItem = {
    name: string;
    icon: Component;
  };

  const nav: NavItem[] = [
    { name: "Appearance", icon: PaintbrushIcon },
    { name: "Terminal", icon: TerminalIcon },
    { name: "Worktrees", icon: GitForkIcon },
  ];

  let activeSection = $state("Appearance");

  let lightThemes = $derived(theme.allThemes.filter((t) => t.type === "light"));
  let darkThemes = $derived(theme.allThemes.filter((t) => t.type === "dark"));
  let isFixedLight = $derived(theme.settings.colorScheme === "light");
  let fixedThemes = $derived(isFixedLight ? lightThemes : darkThemes);
  let fixedCurrent = $derived(
    isFixedLight ? theme.settings.lightTheme : theme.settings.darkTheme,
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="overflow-hidden p-0 md:max-h-[500px]
      md:max-w-[700px] lg:max-w-[800px]"
    trapFocus={false}
  >
    <Dialog.Title class="sr-only">Settings</Dialog.Title>
    <Dialog.Description class="sr-only">
      Customize your settings here.
    </Dialog.Description>
    <Sidebar.Provider class="items-start">
      <Sidebar.Root collapsible="none" class="hidden md:flex">
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupContent>
              <Sidebar.Menu>
                {#each nav as item (item.name)}
                  <Sidebar.MenuItem>
                    <Sidebar.MenuButton
                      isActive={activeSection === item.name}
                      onclick={() => {
                        activeSection = item.name;
                      }}
                    >
                      <item.icon />
                      <span>{item.name}</span>
                    </Sidebar.MenuButton>
                  </Sidebar.MenuItem>
                {/each}
              </Sidebar.Menu>
            </Sidebar.GroupContent>
          </Sidebar.Group>
        </Sidebar.Content>
      </Sidebar.Root>
      <main class="flex h-[480px] flex-1 flex-col overflow-hidden">
        <header
          class="flex h-12 shrink-0 items-center gap-2
            border-b px-4"
        >
          <!-- Desktop: breadcrumb -->
          <Breadcrumb.Root class="hidden md:block">
            <Breadcrumb.List>
              <Breadcrumb.Item>
                <Breadcrumb.Link href="##">Settings</Breadcrumb.Link>
              </Breadcrumb.Item>
              <Breadcrumb.Separator />
              <Breadcrumb.Item>
                <Breadcrumb.Page>
                  {activeSection}
                </Breadcrumb.Page>
              </Breadcrumb.Item>
            </Breadcrumb.List>
          </Breadcrumb.Root>
          <!-- Mobile: select dropdown -->
          <div class="md:hidden flex-1">
            <Select.Root
              type="single"
              value={activeSection}
              onValueChange={(v) => {
                if (v) activeSection = v;
              }}
            >
              <Select.Trigger class="w-full">
                <span data-slot="select-value">
                  {activeSection}
                </span>
              </Select.Trigger>
              <Select.Content>
                {#each nav as item (item.name)}
                  <Select.Item value={item.name} label={item.name}>
                    {item.name}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        </header>
        <div
          class="flex flex-1 flex-col gap-4 overflow-y-auto
            p-4"
        >
          {#if activeSection === "Appearance"}
            <!-- Color Scheme -->
            <section class="space-y-3">
              <h3 class="text-sm font-medium">Color Scheme</h3>
              <div
                class="grid grid-cols-[120px_1fr]
                  items-center gap-3"
              >
                <Label>Mode</Label>
                <div class="flex gap-1">
                  <Button
                    variant={theme.settings.colorScheme === "light"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      theme.updateSettings({
                        colorScheme: "light",
                      })}
                  >
                    <Sun class="mr-1.5 h-3.5 w-3.5" />
                    Light
                  </Button>
                  <Button
                    variant={theme.settings.colorScheme === "dark"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      theme.updateSettings({
                        colorScheme: "dark",
                      })}
                  >
                    <Moon class="mr-1.5 h-3.5 w-3.5" />
                    Dark
                  </Button>
                  <Button
                    variant={theme.settings.colorScheme === "auto"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      theme.updateSettings({
                        colorScheme: "auto",
                      })}
                  >
                    <Monitor class="mr-1.5 h-3.5 w-3.5" />
                    Auto
                  </Button>
                </div>
              </div>

              {#if theme.settings.colorScheme === "auto"}
                <ThemeSelect
                  label="Light Theme"
                  themes={lightThemes}
                  value={theme.settings.lightTheme}
                  onchange={(v) => theme.updateSettings({ lightTheme: v })}
                />
                <ThemeSelect
                  label="Dark Theme"
                  themes={darkThemes}
                  value={theme.settings.darkTheme}
                  onchange={(v) => theme.updateSettings({ darkTheme: v })}
                />
              {:else}
                <ThemeSelect
                  label="Theme"
                  themes={fixedThemes}
                  value={fixedCurrent}
                  onchange={(v) =>
                    theme.updateSettings(
                      isFixedLight ? { lightTheme: v } : { darkTheme: v },
                    )}
                />
              {/if}
            </section>

            <Separator />

            <!-- Manage Themes -->
            <section class="space-y-3">
              <h3 class="text-sm font-medium">Manage Themes</h3>
              <ThemeManager />
            </section>
          {:else if activeSection === "Terminal"}
            <section class="space-y-3">
              <h3 class="text-sm font-medium">Font</h3>

              <!-- Font Source -->
              <div
                class="grid grid-cols-[120px_1fr]
                  items-center gap-3"
              >
                <Label>Source</Label>
                <div class="flex gap-1">
                  <Button
                    variant={termStore.settings.fontSource === "default"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      termStore.updateSettings({
                        fontSource: "default",
                      })}
                  >
                    Default
                  </Button>
                  <Button
                    variant={termStore.settings.fontSource === "system"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      termStore.updateSettings({
                        fontSource: "system",
                      })}
                  >
                    System
                  </Button>
                  <Button
                    variant={termStore.settings.fontSource === "bundled"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      termStore.updateSettings({
                        fontSource: "bundled",
                      })}
                  >
                    <Type class="mr-1.5 h-3.5 w-3.5" />
                    Bundled
                  </Button>
                </div>
              </div>

              <!-- System font input -->
              {#if termStore.settings.fontSource === "system"}
                <div
                  class="grid grid-cols-[120px_1fr]
                    items-center gap-3"
                >
                  <Label>Font Family</Label>
                  <Input
                    type="text"
                    placeholder="'My Font', monospace"
                    value={termStore.settings.systemFontFamily}
                    onchange={(e) =>
                      termStore.updateSettings({
                        systemFontFamily: e.currentTarget.value,
                      })}
                  />
                </div>
              {/if}

              <!-- Bundled font picker -->
              {#if termStore.settings.fontSource === "bundled"}
                <div
                  class="grid grid-cols-[120px_1fr]
                    items-center gap-3"
                >
                  <Label>Bundled Font</Label>
                  <Select.Root
                    type="single"
                    value={termStore.settings.bundledFont}
                    onValueChange={(v) => {
                      if (v)
                        termStore.updateSettings({
                          bundledFont: v,
                        });
                    }}
                  >
                    <Select.Trigger class="w-full">
                      <span data-slot="select-value">
                        {BUNDLED_FONTS.find(
                          (f) => f.id === termStore.settings.bundledFont,
                        )?.name ?? "Select…"}
                      </span>
                    </Select.Trigger>
                    <Select.Content>
                      {#each BUNDLED_FONTS as font (font.id)}
                        <Select.Item value={font.id} label={font.name}>
                          {font.name}
                        </Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
              {/if}

              <!-- Font Size -->
              <div
                class="grid grid-cols-[120px_1fr]
                  items-center gap-3"
              >
                <Label>Font Size</Label>
                <div class="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={termStore.settings.fontSize <= 8}
                    onclick={() =>
                      termStore.updateSettings({
                        fontSize: termStore.settings.fontSize - 1,
                      })}
                  >
                    <Minus class="h-3.5 w-3.5" />
                  </Button>
                  <Input
                    type="text"
                    inputmode="numeric"
                    value={termStore.settings.fontSize}
                    onchange={(e) => {
                      termStore.updateSettings({
                        fontSize: parseInt(e.currentTarget.value, 10) || 14,
                      });
                      e.currentTarget.value = String(
                        termStore.settings.fontSize,
                      );
                    }}
                    class="h-8 w-14 text-center"
                  />
                  <Button
                    variant="outline"
                    size="icon-sm"
                    disabled={termStore.settings.fontSize >= 32}
                    onclick={() =>
                      termStore.updateSettings({
                        fontSize: termStore.settings.fontSize + 1,
                      })}
                  >
                    <Plus class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <!-- Font Preview -->
              <div
                class="grid grid-cols-[120px_1fr]
                  items-start gap-3"
              >
                <Label class="pt-2">Preview</Label>
                <div
                  class="overflow-hidden rounded-md border"
                  style:background-color="var(--terminal-background)"
                  style:color="var(--terminal-foreground)"
                >
                  <pre
                    class="m-0 overflow-hidden p-3
                      leading-normal"
                    style="font-family: {termStore.fontFamily};
                     font-size: {termStore.fontSize}px;"><span
                      style="color:var(--terminal-ansi-green)">$</span
                    > echo "Hello, World!"
{#each fontPreviewLines as line (line)}{line}
                    {/each}</pre>
                </div>
              </div>
            </section>
          {:else if activeSection === "Worktrees"}
            <section class="space-y-3">
              <h3 class="text-sm font-medium">Location</h3>
              <div
                class="grid grid-cols-[120px_1fr]
                  items-center gap-3"
              >
                <Label>Mode</Label>
                <div class="flex gap-1">
                  <Button
                    variant={worktreeSettings.settings.locationMode ===
                    "dataDir"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      worktreeSettings.updateSettings({
                        locationMode: "dataDir",
                      })}
                  >
                    Data Dir
                  </Button>
                  <Button
                    variant={worktreeSettings.settings.locationMode ===
                    "repoLocalDotHubris"
                      ? "secondary"
                      : "ghost"}
                    size="sm"
                    onclick={() =>
                      worktreeSettings.updateSettings({
                        locationMode: "repoLocalDotHubris",
                      })}
                  >
                    Repo .hubris
                  </Button>
                </div>
              </div>
            </section>
          {/if}
        </div>
      </main>
    </Sidebar.Provider>
  </Dialog.Content>
</Dialog.Root>
