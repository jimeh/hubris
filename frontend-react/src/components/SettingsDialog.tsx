import { useState } from "react";
import { Paintbrush, Terminal, GitFork } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { TerminalSettings } from "./settings/TerminalSettings";
import { WorktreeSettings } from "./settings/WorktreeSettings";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface NavItem {
  name: string;
  icon: LucideIcon;
}

const nav: NavItem[] = [
  { name: "Appearance", icon: Paintbrush },
  { name: "Terminal", icon: Terminal },
  { name: "Worktrees", icon: GitFork },
];

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeSection, setActiveSection] = useState("Appearance");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "overflow-hidden p-0",
          "md:max-h-[500px]",
          "md:max-w-[700px] lg:max-w-[800px]",
        )}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your settings here.
        </DialogDescription>
        <SidebarProvider className="items-start">
          <Sidebar
            collapsible="none"
            className={cn("hidden border-r", "border-sidebar-border md:flex")}
          >
            <SidebarHeader
              className={cn(
                "h-12 justify-center gap-0",
                "border-b border-sidebar-border",
                "px-4 py-0",
              )}
            >
              <h2 className="text-base font-semibold">Settings</h2>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {nav.map((item) => (
                      <SidebarMenuItem key={item.name}>
                        <SidebarMenuButton
                          isActive={activeSection === item.name}
                          className={cn(
                            "data-[active=true]:bg-sidebar-primary",
                            "data-[active=true]:text-sidebar-primary-foreground",
                          )}
                          onClick={() => setActiveSection(item.name)}
                        >
                          <item.icon />
                          <span>{item.name}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>
          <main
            className={cn("flex h-[480px] flex-1 flex-col", "overflow-hidden")}
          >
            <header
              className={cn(
                "flex h-12 shrink-0 items-center",
                "gap-2 border-b px-4",
              )}
            >
              {/* Desktop: breadcrumb */}
              <Breadcrumb className="hidden md:block">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{activeSection}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              {/* Mobile: select dropdown */}
              <div className="flex-1 md:hidden">
                <Select
                  value={activeSection}
                  onValueChange={(v) => {
                    if (v) setActiveSection(v);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue>{activeSection}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {nav.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </header>
            <div
              className={cn(
                "flex flex-1 flex-col gap-4",
                "overflow-y-auto p-4",
              )}
            >
              {activeSection === "Appearance" && <AppearanceSettings />}
              {activeSection === "Terminal" && <TerminalSettings />}
              {activeSection === "Worktrees" && <WorktreeSettings />}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  );
}
