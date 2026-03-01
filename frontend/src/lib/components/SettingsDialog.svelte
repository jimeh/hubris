<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { Separator } from '$lib/components/ui/separator/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import { getThemeStore } from '$lib/stores/theme.svelte';
  import ThemeManager from './ThemeManager.svelte';
  import ThemeSelect from './ThemeSelect.svelte';
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
