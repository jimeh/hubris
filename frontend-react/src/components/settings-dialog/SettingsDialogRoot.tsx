import { useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
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
import AppearanceSettings from "./AppearanceSettings";
import TerminalSettings from "./TerminalSettings";
import WorktreeSettings from "./WorktreeSettings";
import {
  sections,
  type SectionName,
  type SettingsDialogProps,
} from "./sections";

export default function SettingsDialogRoot({
  open,
  onOpenChange,
}: SettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<SectionName>("Appearance");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[500px] md:max-w-[700px] lg:max-w-[800px]">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your settings here.
        </DialogDescription>
        <div className="flex h-[480px] overflow-hidden">
          <aside className="hidden w-56 shrink-0 border-r md:flex md:flex-col">
            <div className="flex h-12 items-center border-b px-4">
              <h2 className="text-base font-semibold">Settings</h2>
            </div>
            <div className="flex-1 p-2">
              {sections.map((item) => (
                <Button
                  key={item.name}
                  variant={activeSection === item.name ? "secondary" : "ghost"}
                  className="mb-1 w-full justify-start"
                  onClick={() => setActiveSection(item.name)}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.name}</span>
                </Button>
              ))}
            </div>
          </aside>
          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
              <Breadcrumb className="hidden md:block">
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbPage>{activeSection}</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              <div className="flex-1 md:hidden">
                <Select
                  value={activeSection}
                  onValueChange={(value) =>
                    setActiveSection(value as SectionName)
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {sections.map((item) => (
                      <SelectItem key={item.name} value={item.name}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </header>
            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
              {activeSection === "Appearance" ? <AppearanceSettings /> : null}
              {activeSection === "Terminal" ? <TerminalSettings /> : null}
              {activeSection === "Worktrees" ? <WorktreeSettings /> : null}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
