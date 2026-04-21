import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettingsStore } from "@/lib/stores/settings";
import { useChatSettings } from "@/lib/stores/chatSettings";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-center sm:gap-3";

export default function ChatSettings() {
  const settings = useChatSettings((state) => state.settings);
  const updateSettings = useChatSettings((state) => state.updateSettings);
  const writesBlocked = useSettingsStore((state) => state.status.writesBlocked);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Runtime</h3>
      </div>
      <div className={settingsRowClass}>
        <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
          Idle Timeout
        </Label>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Shut down inactive Codex runtimes after this many minutes.
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={writesBlocked || settings.idleTimeoutMinutes <= 1}
              onClick={() =>
                updateSettings({
                  idleTimeoutMinutes: settings.idleTimeoutMinutes - 1,
                })
              }
            >
              -
            </Button>
            <Input
              type="text"
              inputMode="numeric"
              className="h-8 w-20 text-center"
              value={String(settings.idleTimeoutMinutes)}
              disabled={writesBlocked}
              onChange={(event) => {
                const parsed = Number.parseInt(event.currentTarget.value, 10);
                updateSettings({
                  idleTimeoutMinutes: Number.isFinite(parsed) ? parsed : 5,
                });
              }}
            />
            <span className="text-sm text-muted-foreground">minutes</span>
            <Button
              variant="outline"
              size="sm"
              disabled={writesBlocked || settings.idleTimeoutMinutes >= 120}
              onClick={() =>
                updateSettings({
                  idleTimeoutMinutes: settings.idleTimeoutMinutes + 1,
                })
              }
            >
              +
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
