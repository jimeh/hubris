import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { themeEntries } from "@/lib/stores/theme";

const settingsRowClass =
  "grid gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center sm:gap-3";

export default function ThemeSelect({
  label,
  themes,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  themes: ReturnType<typeof themeEntries>;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selectedName =
    themes.find((theme) => theme.id === value)?.name ?? "Select…";

  return (
    <div className={settingsRowClass}>
      <Label className="text-xs font-medium text-muted-foreground sm:text-sm">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full" disabled={disabled}>
          <SelectValue placeholder={selectedName} />
        </SelectTrigger>
        <SelectContent>
          {themes.map((theme) => (
            <SelectItem key={theme.id} value={theme.id}>
              {theme.name}
              {theme.builtin ? (
                <span className="ml-1 text-xs text-muted-foreground">
                  Built-in
                </span>
              ) : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
