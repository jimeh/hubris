import { GitFork } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useWorktreeSettingsStore } from "$lib/stores/worktreeSettings";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center sm:gap-3";

export default function WorktreeSettings() {
  const settings = useWorktreeSettingsStore((state) => state.settings);
  const updateSettings = useWorktreeSettingsStore(
    (state) => state.updateSettings,
  );

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <GitFork className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Location</h3>
      </div>
      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Mode
        </Label>
        <div className="flex flex-wrap gap-1">
          <Button
            variant={
              settings.locationMode === "dataDir" ? "secondary" : "ghost"
            }
            size="sm"
            onClick={() => void updateSettings({ locationMode: "dataDir" })}
          >
            Data Dir
          </Button>
          <Button
            variant={
              settings.locationMode === "repoLocalDotHubris"
                ? "secondary"
                : "ghost"
            }
            size="sm"
            onClick={() =>
              void updateSettings({ locationMode: "repoLocalDotHubris" })
            }
          >
            Repo .hubris
          </Button>
        </div>
      </div>
    </section>
  );
}
