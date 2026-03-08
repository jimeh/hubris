import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useWorktreeSettingsStore } from "$lib/stores/worktreeSettings";

export default function WorktreeSettings() {
  const settings = useWorktreeSettingsStore((state) => state.settings);
  const updateSettings = useWorktreeSettingsStore(
    (state) => state.updateSettings,
  );

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">Location</h3>
      <div className="grid grid-cols-[120px_1fr] items-center gap-3">
        <Label>Mode</Label>
        <div className="flex gap-1">
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
