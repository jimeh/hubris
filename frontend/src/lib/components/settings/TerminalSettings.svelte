<script lang="ts">
  import * as Select from "$lib/components/ui/select/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { getTerminalStore } from "$lib/stores/terminal.svelte";
  import { BUNDLED_FONTS } from "$lib/terminal/fonts";
  import { Type, Minus, Plus } from "@lucide/svelte";

  const termStore = getTerminalStore();

  const fontPreviewLines = [
    "Hello, World!",
    "ABCDEFGHIJKLM 0123456789",
    "abcdefghijklm ~!@#$%^&*()",
  ];
</script>

<section class="space-y-3">
  <h3 class="text-sm font-medium">Font</h3>

  <!-- Font Source -->
  <div class="grid grid-cols-[120px_1fr] items-center gap-3">
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
    <div class="grid grid-cols-[120px_1fr] items-center gap-3">
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
    <div class="grid grid-cols-[120px_1fr] items-center gap-3">
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
            {BUNDLED_FONTS.find((f) => f.id === termStore.settings.bundledFont)
              ?.name ?? "Select…"}
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
  <div class="grid grid-cols-[120px_1fr] items-center gap-3">
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
          e.currentTarget.value = String(termStore.settings.fontSize);
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
  <div class="grid grid-cols-[120px_1fr] items-start gap-3">
    <Label class="pt-2">Preview</Label>
    <div
      class="overflow-hidden rounded-md border"
      style:background-color="var(--terminal-background)"
      style:color="var(--terminal-foreground)"
    >
      <pre
        class="m-0 overflow-hidden p-3 leading-normal"
        style="font-family: {termStore.fontFamily};
                     font-size: {termStore.fontSize}px;"><span
          style="color:var(--terminal-ansi-green)">$</span
        > echo "Hello, World!"
{#each fontPreviewLines as line (line)}{line}
        {/each}</pre>
    </div>
  </div>
</section>
