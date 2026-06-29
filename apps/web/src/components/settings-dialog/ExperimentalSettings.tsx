import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import ChatSettings from "./ChatSettings";
import { useSettingsStore } from "@/lib/stores/settings";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-center sm:gap-3";

export default function ExperimentalSettings() {
  const chatEnabled = useSettingsStore(
    (state) => state.settings.experimental.chatEnabled,
  );
  const writesBlocked = useSettingsStore((state) => state.status.writesBlocked);
  const updateExperimental = useSettingsStore(
    (state) => state.updateExperimental,
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Experimental</h3>
      </div>
      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Chat
        </Label>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            <Button
              variant={chatEnabled ? "secondary" : "ghost"}
              size="sm"
              disabled={writesBlocked}
              onClick={() => updateExperimental({ chatEnabled: true })}
            >
              Enabled
            </Button>
            <Button
              variant={!chatEnabled ? "secondary" : "ghost"}
              size="sm"
              disabled={writesBlocked}
              onClick={() => updateExperimental({ chatEnabled: false })}
            >
              Disabled
            </Button>
          </div>
        </div>
      </div>
      {chatEnabled ? <ChatSettings /> : null}
    </section>
  );
}
