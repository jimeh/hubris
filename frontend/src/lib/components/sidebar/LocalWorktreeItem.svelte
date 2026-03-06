<script lang="ts">
  let {
    isSelected,
    onSelect,
  }: {
    isSelected: boolean;
    onSelect: () => void;
  } = $props();
</script>

<button
  class="flex w-full cursor-default select-none items-center
    gap-1 rounded-md px-2 py-1 text-left text-sm
    hover:bg-sidebar-accent
    {isSelected
    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
    : 'text-sidebar-foreground/80'}"
  onclick={() => onSelect()}
>
  <span
    class="flex h-6 w-5 shrink-0 items-center justify-center"
    aria-hidden="true"
  ></span>
  <span class="truncate">local</span>
</button>
