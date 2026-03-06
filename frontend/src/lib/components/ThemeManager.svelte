<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import * as ScrollArea from "$lib/components/ui/scroll-area/index.js";
  import { getThemeStore } from "$lib/stores/theme.svelte";
  import { parseVscodeTheme } from "$lib/theme/parse";
  import type { VscodeThemeFile } from "$lib/theme/types";
  import { Upload, Trash2 } from "@lucide/svelte";

  const theme = getThemeStore();
  let error = $state("");
  let fileInput: HTMLInputElement;

  let userThemes = $derived(theme.allThemes.filter((t) => !t.builtin));

  async function handleFileUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    error = "";

    try {
      const text = await file.text();
      const raw: VscodeThemeFile = JSON.parse(text);
      if (!raw.colors || typeof raw.colors !== "object") {
        throw new Error('Invalid theme: missing "colors" object');
      }
      const parsed = parseVscodeTheme(raw, file.name);

      // Check for ID conflict
      if (theme.allThemes.find((t) => t.id === parsed.id)) {
        throw new Error(`Theme "${parsed.name}" already exists`);
      }

      await theme.addUserTheme(parsed);
    } catch (err) {
      error = (err as Error).message;
    } finally {
      input.value = "";
    }
  }

  async function handleDelete(id: string) {
    error = "";
    try {
      await theme.removeUserTheme(id);
    } catch (err) {
      error = (err as Error).message;
    }
  }
</script>

<div class="space-y-2">
  <input
    bind:this={fileInput}
    type="file"
    accept=".json"
    class="hidden"
    onchange={handleFileUpload}
  />
  <Button variant="outline" size="sm" onclick={() => fileInput.click()}>
    <Upload class="mr-1.5 h-3.5 w-3.5" />
    Import VS Code Theme
  </Button>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if userThemes.length > 0}
    <ScrollArea.Root class="max-h-[160px]">
      <div class="space-y-1">
        {#each userThemes as t (t.id)}
          <div
            class="flex items-center justify-between
                   rounded-md px-2 py-1.5 text-sm"
          >
            <div class="flex items-center gap-2">
              <span>{t.name}</span>
              <span class="text-xs text-muted-foreground">
                {t.type}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onclick={() => handleDelete(t.id)}
            >
              <Trash2 class="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </div>
        {/each}
      </div>
    </ScrollArea.Root>
  {:else}
    <p class="text-sm text-muted-foreground">
      No custom themes installed. Import a VS Code color theme JSON file to get
      started.
    </p>
  {/if}
</div>
