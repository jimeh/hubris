import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { themeEntries } from "$lib/stores/theme";

export default function ThemeSelect({
  label,
  themes,
  value,
  onChange,
}: {
  label: string;
  themes: ReturnType<typeof themeEntries>;
  value: string;
  onChange: (value: string) => void;
}) {
  const selectedName =
    themes.find((theme) => theme.id === value)?.name ?? "Select…";

  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
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
