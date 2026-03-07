<script lang="ts">
  import * as Breadcrumb from "$lib/components/ui/breadcrumb/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import * as Sidebar from "$lib/components/ui/sidebar/index.js";
  import PaintbrushIcon from "@lucide/svelte/icons/paintbrush";
  import TerminalIcon from "@lucide/svelte/icons/terminal";
  import GitForkIcon from "@lucide/svelte/icons/git-fork";
  import type { Component } from "svelte";
  import AppearanceSettings from "./settings/AppearanceSettings.svelte";
  import TerminalSettings from "./settings/TerminalSettings.svelte";
  import WorktreeSettings from "./settings/WorktreeSettings.svelte";

  let {
    open = $bindable(false),
  }: {
    open?: boolean;
  } = $props();

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
      <Sidebar.Root
        collapsible="none"
        class="hidden border-r border-sidebar-border md:flex"
      >
        <Sidebar.Header
          class="h-12 justify-center gap-0 border-b border-sidebar-border
            px-4 py-0"
        >
          <h2 class="text-base font-semibold">Settings</h2>
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.GroupContent>
              <Sidebar.Menu>
                {#each nav as item (item.name)}
                  <Sidebar.MenuItem>
                    <Sidebar.MenuButton
                      isActive={activeSection === item.name}
                      class="data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground"
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
                <Breadcrumb.Page>
                  {activeSection}
                </Breadcrumb.Page>
              </Breadcrumb.Item>
            </Breadcrumb.List>
          </Breadcrumb.Root>
          <!-- Mobile: select dropdown -->
          <div class="flex-1 md:hidden">
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
            <AppearanceSettings />
          {:else if activeSection === "Terminal"}
            <TerminalSettings />
          {:else if activeSection === "Worktrees"}
            <WorktreeSettings />
          {/if}
        </div>
      </main>
    </Sidebar.Provider>
  </Dialog.Content>
</Dialog.Root>
