import { useMemo } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  executeCommand,
  getCommandPaletteItems,
  useCommandContext,
} from "@/lib/commands";
import { useCommandUiStore } from "@/lib/stores/commandUi";

export default function CommandPalette() {
  const context = useCommandContext();
  const items = useMemo(() => getCommandPaletteItems(context), [context]);
  const paletteOpen = useCommandUiStore((state) => state.paletteOpen);
  const paletteQuery = useCommandUiStore((state) => state.paletteQuery);
  const closePalette = useCommandUiStore((state) => state.closePalette);
  const setPaletteOpen = useCommandUiStore((state) => state.setPaletteOpen);
  const setPaletteQuery = useCommandUiStore((state) => state.setPaletteQuery);

  const groups = useMemo(() => {
    return Object.entries(
      items.reduce<Record<string, typeof items>>((result, item) => {
        result[item.group] = [...(result[item.group] ?? []), item];
        return result;
      }, {}),
    );
  }, [items]);

  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      <CommandInput
        placeholder="Run a command..."
        value={paletteQuery}
        onValueChange={setPaletteQuery}
      />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        {groups.map(([group, groupItems]) => (
          <CommandGroup key={group} heading={group}>
            {groupItems.map((item) => {
              const Icon = item.icon;

              return (
                <CommandItem
                  key={item.key}
                  keywords={item.keywords}
                  onSelect={() => {
                    closePalette();
                    void executeCommand({
                      args: item.args as never,
                      id: item.id,
                      source: "command-palette",
                    });
                  }}
                  value={
                    item.searchText ?? `${item.title} ${item.subtitle ?? ""}`
                  }
                >
                  {Icon ? <Icon className="h-4 w-4" /> : null}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{item.title}</span>
                    {item.subtitle ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {item.subtitle}
                      </span>
                    ) : null}
                  </div>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
