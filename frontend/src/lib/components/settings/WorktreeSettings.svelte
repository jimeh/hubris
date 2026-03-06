<script lang="ts">
  import { Button } from "$lib/components/ui/button/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { getWorktreeSettingsStore } from "$lib/stores/worktreeSettings.svelte";

  const worktreeSettings = getWorktreeSettingsStore();
</script>

<section class="space-y-3">
  <h3 class="text-sm font-medium">Location</h3>
  <div class="grid grid-cols-[120px_1fr] items-center gap-3">
    <Label>Mode</Label>
    <div class="flex gap-1">
      <Button
        variant={worktreeSettings.settings.locationMode === "dataDir"
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
        variant={worktreeSettings.settings.locationMode === "repoLocalDotHubris"
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
