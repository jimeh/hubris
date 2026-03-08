import { useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Plus, Settings } from "lucide-react";
import { createDialogState, type SidebarDialogState } from "./sidebar/types";
import { ProjectList } from "./sidebar/ProjectList";
import { SidebarDialogs } from "./sidebar/SidebarDialogs";

export function AppSidebar() {
  const [dialogState, setDialogState] =
    useState<SidebarDialogState>(createDialogState());

  return (
    <>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between px-2">
            <h2 className="text-lg font-semibold">Projects</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() =>
                setDialogState((s) => ({
                  ...s,
                  showSettings: true,
                }))
              }
              title="Settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <ProjectList setDialogState={setDialogState} />
        </SidebarContent>

        <SidebarSeparator />

        <SidebarFooter>
          <Button
            variant="ghost"
            className="w-full text-muted-foreground"
            onClick={() =>
              setDialogState((s) => ({
                ...s,
                addProject: true,
              }))
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Project
          </Button>
        </SidebarFooter>
        {dialogState.actionError && (
          <p className="px-2 pb-2 text-xs text-destructive">
            {dialogState.actionError}
          </p>
        )}
      </Sidebar>

      <SidebarDialogs
        dialogState={dialogState}
        setDialogState={setDialogState}
      />
    </>
  );
}
