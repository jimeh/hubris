import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import AppearanceSettings from "./AppearanceSettings";
import ChatSettings from "./ChatSettings";
import EditorSettings from "./EditorSettings";
import KeyboardShortcutsSettings from "./KeyboardShortcutsSettings";
import TerminalSettings from "./TerminalSettings";
import VscodeSettings from "./VscodeSettings";
import WorktreeSettings from "./WorktreeSettings";
import {
  sections,
  type SectionName,
  type SettingsDialogProps,
} from "./sections";
import SettingsStatusNotice from "@/components/SettingsStatusNotice";
import { useSettingsStore } from "@/lib/stores/settings";
import { cn } from "@/lib/utils";

function SettingsDialogBody({
  initialSection = "Appearance",
  onSectionChange,
  open,
  onOpenChange,
}: SettingsDialogProps & {
  onSectionChange: (section: SectionName) => void;
}) {
  const [activeSection, setActiveSection] =
    useState<SectionName>(initialSection);
  const settingsStatus = useSettingsStore((state) => state.status);
  function selectSection(section: SectionName): void {
    setActiveSection(section);
    onSectionChange(section);
  }

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen) {
      onSectionChange(activeSection);
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="top-2 right-2 bottom-2 left-2 h-auto max-h-none w-auto max-w-none translate-x-0 translate-y-0 overflow-hidden p-0 sm:max-w-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your settings here.
        </DialogDescription>
        <SidebarProvider className="h-full min-h-0 items-start overflow-hidden">
          <Sidebar
            collapsible="none"
            className="hidden border-r border-sidebar-border md:flex"
          >
            <SidebarHeader className="h-12 justify-center gap-0 border-b border-sidebar-border px-4 py-0">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <DialogClose asChild>
                  <button
                    type="button"
                    aria-label="Close settings"
                    className="rounded-xs text-muted-foreground transition-colors hover:text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                </DialogClose>
                <span>Settings</span>
              </h2>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {sections.map((item) => (
                      <SidebarMenuItem key={item.name}>
                        <SidebarMenuButton
                          isActive={activeSection === item.name}
                          className="data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground"
                          onClick={() => selectSection(item.name)}
                        >
                          <item.icon className="h-4 w-4" />
                          <span>{item.name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main className="flex h-full flex-1 flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center border-b px-3 pr-14 sm:px-4 md:pr-4">
              <div className="flex items-center gap-2 md:hidden">
                <DialogClose asChild>
                  <button
                    type="button"
                    aria-label="Close settings"
                    className="rounded-xs text-muted-foreground transition-colors hover:text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                </DialogClose>
                <span className="text-sm font-medium">Settings</span>
              </div>
              <Breadcrumb className="hidden md:block">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{activeSection}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </header>
            <div className="border-b px-3 py-2 sm:px-4 md:hidden">
              <div className="flex min-w-0 items-center gap-2">
                <Select
                  value={activeSection}
                  onValueChange={(value) => selectSection(value as SectionName)}
                >
                  <SelectTrigger className="w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sections.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        <div className="flex items-center gap-2">
                          <item.icon className="h-4 w-4" />
                          <span>{item.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div
              className={cn(
                "flex flex-1 flex-col gap-4 p-3 sm:p-4",
                activeSection === "Keyboard Shortcuts"
                  ? "min-h-0 overflow-hidden"
                  : "overflow-y-auto",
              )}
            >
              <SettingsStatusNotice status={settingsStatus} variant="dialog" />
              {activeSection === "Appearance" ? <AppearanceSettings /> : null}
              {activeSection === "Editor" ? <EditorSettings /> : null}
              {activeSection === "Terminal" ? <TerminalSettings /> : null}
              {activeSection === "Keyboard Shortcuts" ? (
                <KeyboardShortcutsSettings />
              ) : null}
              {activeSection === "VS Code" ? <VscodeSettings /> : null}
              {activeSection === "Worktrees" ? <WorktreeSettings /> : null}
              {activeSection === "Chats" ? <ChatSettings /> : null}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}

export default function SettingsDialogRoot(props: SettingsDialogProps) {
  const { initialSection, open } = props;
  const [rememberedSection, setRememberedSection] =
    useState<SectionName>("Appearance");
  const sectionToOpen = initialSection ?? rememberedSection;

  return (
    <SettingsDialogBody
      key={
        open
          ? initialSection
            ? `section:${initialSection}`
            : "open"
          : "__closed__"
      }
      {...props}
      initialSection={sectionToOpen}
      onSectionChange={setRememberedSection}
    />
  );
}
