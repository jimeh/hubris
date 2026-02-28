<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import * as Select from '$lib/components/ui/select/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { getThemeStore } from '$lib/stores/theme.svelte';
  import ThemeManager from './ThemeManager.svelte';
  import { Sun, Moon, Monitor } from '@lucide/svelte';

  let {
    open = $bindable(false),
  }: {
    open?: boolean;
  } = $props();

  const theme = getThemeStore();

  let lightThemes = $derived(theme.allThemes.filter((t) => t.type === 'light'));
  let darkThemes = $derived(theme.allThemes.filter((t) => t.type === 'dark'));
  let isFixedLight = $derived(theme.settings.colorScheme === 'light');
  let fixedThemes = $derived(isFixedLight ? lightThemes : darkThemes);
  let fixedCurrent = $derived(
    isFixedLight ? theme.settings.lightTheme : theme.settings.darkTheme,
  );

  // Derived labels for displaying selected theme names
  let lightThemeName = $derived(
    lightThemes.find((t) => t.id === theme.settings.lightTheme)?.name ??
      'Select…',
  );
  let darkThemeName = $derived(
    darkThemes.find((t) => t.id === theme.settings.darkTheme)?.name ??
      'Select…',
  );
  let fixedThemeName = $derived(
    fixedThemes.find((t) => t.id === fixedCurrent)?.name ?? 'Select…',
  );
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Settings</Dialog.Title>
    </Dialog.Header>

    <div class="space-y-6">
      <!-- Color Scheme -->
      <section class="space-y-3">
        <h3 class="text-sm font-medium">Appearance</h3>

        <div class="grid grid-cols-[120px_1fr] items-center gap-3">
          <Label>Color Scheme</Label>
          <div class="flex gap-1">
            <Button
              variant={theme.settings.colorScheme === 'light'
                ? 'secondary'
                : 'ghost'}
              size="sm"
              onclick={() =>
                theme.updateSettings({
                  colorScheme: 'light',
                })}
            >
              <Sun class="mr-1.5 h-3.5 w-3.5" />
              Light
            </Button>
            <Button
              variant={theme.settings.colorScheme === 'dark'
                ? 'secondary'
                : 'ghost'}
              size="sm"
              onclick={() =>
                theme.updateSettings({
                  colorScheme: 'dark',
                })}
            >
              <Moon class="mr-1.5 h-3.5 w-3.5" />
              Dark
            </Button>
            <Button
              variant={theme.settings.colorScheme === 'auto'
                ? 'secondary'
                : 'ghost'}
              size="sm"
              onclick={() =>
                theme.updateSettings({
                  colorScheme: 'auto',
                })}
            >
              <Monitor class="mr-1.5 h-3.5 w-3.5" />
              Auto
            </Button>
          </div>
        </div>

        <!-- Theme pickers -->
        {#if theme.settings.colorScheme === 'auto'}
          <!-- Show both light and dark pickers -->
          <div class="grid grid-cols-[120px_1fr] items-center gap-3">
            <Label>Light Theme</Label>
            <Select.Root
              type="single"
              value={theme.settings.lightTheme}
              onValueChange={(v: string) => {
                if (v) theme.updateSettings({ lightTheme: v });
              }}
            >
              <Select.Trigger class="w-full">
                <span data-slot="select-value">
                  {lightThemeName}
                </span>
              </Select.Trigger>
              <Select.Content>
                {#each lightThemes as t (t.id)}
                  <Select.Item value={t.id} label={t.name}>
                    {t.name}
                    {#if t.builtin}
                      <span
                        class="ml-1 text-xs
                          text-muted-foreground"
                      >
                        Built-in
                      </span>
                    {/if}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="grid grid-cols-[120px_1fr] items-center gap-3">
            <Label>Dark Theme</Label>
            <Select.Root
              type="single"
              value={theme.settings.darkTheme}
              onValueChange={(v: string) => {
                if (v) theme.updateSettings({ darkTheme: v });
              }}
            >
              <Select.Trigger class="w-full">
                <span data-slot="select-value">
                  {darkThemeName}
                </span>
              </Select.Trigger>
              <Select.Content>
                {#each darkThemes as t (t.id)}
                  <Select.Item value={t.id} label={t.name}>
                    {t.name}
                    {#if t.builtin}
                      <span
                        class="ml-1 text-xs
                          text-muted-foreground"
                      >
                        Built-in
                      </span>
                    {/if}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {:else}
          <!-- Single theme picker for the active scheme -->
          <div class="grid grid-cols-[120px_1fr] items-center gap-3">
            <Label>Theme</Label>
            <Select.Root
              type="single"
              value={fixedCurrent}
              onValueChange={(v: string) => {
                if (v)
                  theme.updateSettings(
                    isFixedLight ? { lightTheme: v } : { darkTheme: v },
                  );
              }}
            >
              <Select.Trigger class="w-full">
                <span data-slot="select-value">
                  {fixedThemeName}
                </span>
              </Select.Trigger>
              <Select.Content>
                {#each fixedThemes as t (t.id)}
                  <Select.Item value={t.id} label={t.name}>
                    {t.name}
                    {#if t.builtin}
                      <span
                        class="ml-1 text-xs
                          text-muted-foreground"
                      >
                        Built-in
                      </span>
                    {/if}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        {/if}
      </section>

      <Separator />

      <!-- User Themes Management -->
      <section class="space-y-3">
        <h3 class="text-sm font-medium">Manage Themes</h3>
        <ThemeManager />
      </section>
    </div>

    <Dialog.Footer>
      <Button variant="outline" onclick={() => (open = false)}>Close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
