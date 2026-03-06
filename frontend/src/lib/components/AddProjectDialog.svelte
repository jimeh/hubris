<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Separator } from "$lib/components/ui/separator/index.js";
  import FileBrowser from "./FileBrowser.svelte";

  let {
    onAdd,
    onClose,
  }: {
    onAdd: (path: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let path = $state("");
  let submitting = $state(false);
  let error = $state("");

  async function submit() {
    if (!path.trim()) return;
    submitting = true;
    error = "";
    try {
      await onAdd(path.trim());
    } catch (e) {
      error = (e as Error).message;
    } finally {
      submitting = false;
    }
  }

  function handleSelect(selectedPath: string) {
    path = selectedPath;
    submit();
  }
</script>

<Dialog.Root
  open
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <Dialog.Content class="sm:max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Add Project</Dialog.Title>
      <Dialog.Description>
        Browse to a directory or enter a path manually.
      </Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-3 py-3">
      <FileBrowser bind:currentPath={path} onSelect={handleSelect} />
      <Separator />
      <div class="flex items-center gap-2">
        <Input
          type="text"
          bind:value={path}
          placeholder="/home/user/repos/myproject"
          disabled={submitting}
          onkeydown={(e: KeyboardEvent) => {
            if (e.key === "Enter") submit();
          }}
          class="flex-1"
        />
        <Button onclick={submit} disabled={submitting || !path.trim()}>
          Add
        </Button>
      </div>
      {#if error}
        <p class="text-sm text-destructive">{error}</p>
      {/if}
    </div>
    <Dialog.Footer>
      <Button variant="outline" onclick={onClose} disabled={submitting}>
        Cancel
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
