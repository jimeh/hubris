import { useState } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FolderPlus, Settings } from "lucide-react";
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
          <div className="flex items-center gap-2 px-2">
            <h2 className="text-lg font-semibold">Projects</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() =>
                    setDialogState((s) => ({
                      ...s,
                      addProject: true,
                    }))
                  }
                >
                  <FolderPlus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                Add project
              </TooltipContent>
            </Tooltip>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <ProjectList setDialogState={setDialogState} />
        </SidebarContent>

        <SidebarFooter>
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground"
            onClick={() =>
              setDialogState((s) => ({
                ...s,
                showSettings: true,
              }))
            }
          >
            <Settings className="mr-2 h-4 w-4" />
            Settings
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
