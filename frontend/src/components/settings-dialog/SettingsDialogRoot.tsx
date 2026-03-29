import { useState } from "react";
import { Settings } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  Dialog,
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
import EditorSettings from "./EditorSettings";
import TerminalSettings from "./TerminalSettings";
import WorktreeSettings from "./WorktreeSettings";
import {
  sections,
  type SectionName,
  type SettingsDialogProps,
} from "./sections";
import SettingsStatusNotice from "@/components/SettingsStatusNotice";
import { useSettingsStore } from "@/lib/stores/settings";

export default function SettingsDialogRoot({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<SectionName>("Appearance");
  const settingsStatus = useSettingsStore((state) => state.status);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-[calc(100%-1rem)] overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your settings here.
        </DialogDescription>
        <SidebarProvider className="min-h-0 items-start overflow-hidden">
          <Sidebar
            collapsible="none"
            className="hidden border-r border-sidebar-border md:flex"
          >
            <SidebarHeader className="h-12 justify-center gap-0 border-b border-sidebar-border px-4 py-0">
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Settings className="h-4 w-4" />
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
                          onClick={() => setActiveSection(item.name)}
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
          <main className="flex h-[calc(100dvh-1rem)] flex-1 flex-col overflow-hidden md:h-[480px]">
            <header className="flex h-12 shrink-0 items-center border-b px-3 pr-14 sm:px-4 md:pr-4">
              <div className="flex items-center gap-2 md:hidden">
                <Settings className="h-4 w-4 shrink-0 text-muted-foreground" />
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
                  onValueChange={(value) =>
                    setActiveSection(value as SectionName)
                  }
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
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4">
              <SettingsStatusNotice status={settingsStatus} variant="dialog" />
              {activeSection === "Appearance" ? <AppearanceSettings /> : null}
              {activeSection === "Editor" ? <EditorSettings /> : null}
              {activeSection === "Terminal" ? <TerminalSettings /> : null}
              {activeSection === "Worktrees" ? <WorktreeSettings /> : null}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
