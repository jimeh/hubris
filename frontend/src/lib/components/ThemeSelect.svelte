<script lang="ts">
  import * as Select from '$lib/components/ui/select/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import type { ThemeListEntry } from '$lib/theme/types';

  let {
    label,
    themes,
    value,
    onchange,
  }: {
    label: string;
    themes: ThemeListEntry[];
    value: string;
    onchange: (id: string) => void;
  } = $props();

  let selectedName = $derived(
    themes.find((t) => t.id === value)?.name ?? 'Select…',
  );
</script>

<div class="grid grid-cols-[120px_1fr] items-center gap-3">
  <Label>{label}</Label>
  <Select.Root
    type="single"
    {value}
    onValueChange={(v: string) => {
      if (v) onchange(v);
    }}
  >
    <Select.Trigger class="w-full">
      <span data-slot="select-value">
        {selectedName}
      </span>
    </Select.Trigger>
    <Select.Content>
      {#each themes as t (t.id)}
        <Select.Item value={t.id} label={t.name}>
          {t.name}
          {#if t.builtin}
            <span class="ml-1 text-xs text-muted-foreground"> Built-in </span>
          {/if}
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>
