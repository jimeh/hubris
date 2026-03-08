import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { ThemeListEntry } from "@/lib/theme/types";

interface ThemeSelectProps {
  label: string;
  themes: ThemeListEntry[];
  value: string;
  onChange: (id: string) => void;
}

export function ThemeSelect({
  label,
  themes,
  value,
  onChange,
}: ThemeSelectProps) {
  const selectedName =
    themes.find((t) => t.id === value)?.name ?? "Select\u2026";

  return (
    <div className={"grid grid-cols-[120px_1fr]" + " items-center gap-3"}>
      <Label>{label}</Label>
      <Select
        value={value}
        onValueChange={(v) => {
          if (v) onChange(v);
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder={selectedName}>{selectedName}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {themes.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
              {t.builtin && (
                <span className={"ml-1 text-xs" + " text-muted-foreground"}>
                  {" "}
                  Built-in
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
