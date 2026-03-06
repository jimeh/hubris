<script lang="ts">
  import type { Project } from "$lib/types";

  let { project }: { project: Project } = $props();
</script>

<div class="flex h-full items-center justify-center text-muted-foreground">
  <p>Project view is deprecated: select a worktree for {project.name}.</p>
</div>
