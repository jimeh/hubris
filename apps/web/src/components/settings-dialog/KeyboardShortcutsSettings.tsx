import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Keyboard,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import KeybindingsStatusNotice from "@/components/KeybindingsStatusNotice";
import {
  argsToFieldValues,
  canEditArgsWithFields,
  commandArgFieldsForCommand,
  fieldValuesToArgs,
  type CommandArgField,
  type CommandArgFieldValues,
} from "@/lib/commands/args";
import type { CommandId } from "@/lib/commands";
import {
  addUserShortcut,
  buildCommandShortcutRows,
  disableCommandDefaults,
  isReservedKeybinding,
  parseArgsText,
  removeUserShortcut,
  replaceUserShortcut,
  resetCommandKeybindings,
  stringifyArgs,
  updateUserShortcutAdvanced,
  validateKeybindingDraft,
  type CommandShortcutBinding,
  type CommandShortcutRow,
  type EditableKeybindingEntry,
} from "@/lib/keybindings/editor";
import {
  formatKeybinding,
  getPlatformFlags,
  keybindingFromEvent,
} from "@/lib/keybindings/keys";
import {
  completeWhenExpression,
  evaluateWhenExpression,
  matchingWhenCompletions,
} from "@/lib/keybindings/when";
import { useKeybindingsStore } from "@/lib/stores/keybindings";
import type {
  JsonValue,
  KeybindingsStatus,
} from "@/lib/contracts/sse.generated";
import { cn } from "@/lib/utils";

const VALIDATION_CONTEXT = {
  activeTabPreview: false,
  activeTabType: "terminal",
  browserFocus: false,
  commandPaletteOpen: false,
  dialogOpen: false,
  editorFocus: false,
  focusedPane: true,
  gitStatusFocus: false,
  inputFocus: false,
  ...getPlatformFlags(),
  selectedProject: true,
  selectedWorktree: true,
  terminalFocus: false,
};

type RecordingTarget = {
  command: CommandId;
  disableDefaults: boolean;
  entryIndex?: number;
};

function sameKeybindings(
  left: EditableKeybindingEntry[],
  right: EditableKeybindingEntry[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function shortcutNames(bindings: CommandShortcutBinding[]): string {
  return bindings
    .map(
      (binding) =>
        `${binding.command}${binding.source === "default" ? "" : " custom"}`,
    )
    .join(", ");
}

const shortcutTableGridClass =
  "grid min-w-[720px] grid-cols-[minmax(220px,1.4fr)_minmax(110px,0.6fr)_minmax(160px,1fr)_minmax(70px,0.35fr)_minmax(40px,auto)] items-center gap-3";
const unsetSelectValue = "__unset__";

type ShortcutTableRow = {
  binding: CommandShortcutBinding | null;
  command: CommandShortcutRow["command"];
  hasCustomizations: boolean;
  id: string;
  row: CommandShortcutRow;
};

export default function KeyboardShortcutsSettings() {
  const keybindings = useKeybindingsStore((state) => state.keybindings);
  const generation = useKeybindingsStore((state) => state.generation);
  const status = useKeybindingsStore((state) => state.status);
  const replaceUserKeybindings = useKeybindingsStore(
    (state) => state.replaceUserKeybindings,
  );

  return (
    <KeyboardShortcutsSettingsInner
      key={generation}
      keybindings={keybindings}
      replaceUserKeybindings={replaceUserKeybindings}
      status={status}
    />
  );
}

function ShortcutAdvancedPanel({
  binding,
  disabled,
  onApply,
}: {
  binding: CommandShortcutBinding;
  disabled: boolean;
  onApply: (when: string, args: JsonValue | undefined) => void;
}) {
  const [when, setWhen] = useState(binding.when ?? "");
  const argFields = commandArgFieldsForCommand(binding.command);
  const structuredArgs = canEditArgsWithFields(binding.args, argFields);
  const [argValues, setArgValues] = useState<CommandArgFieldValues>(() =>
    argsToFieldValues(binding.args, argFields),
  );
  const [argsText, setArgsText] = useState(stringifyArgs(binding.args));
  const [error, setError] = useState<string | null>(null);

  function validateAndApply(): void {
    try {
      if (when.trim()) {
        evaluateWhenExpression(when, VALIDATION_CONTEXT);
      }
      const args = structuredArgs
        ? fieldValuesToArgs(argFields, argValues)
        : parseArgsText(argsText);
      onApply(when, args);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  function updateArgValue(key: string, value: string): void {
    setArgValues((current) => ({ ...current, [key]: value }));
  }

  return (
    <div className="border-t border-b bg-muted/20 px-3 py-3">
      <div className="grid min-w-[720px] gap-3 md:grid-cols-[minmax(240px,1fr)_minmax(240px,1fr)_auto]">
        <div className="grid gap-1 text-xs text-muted-foreground">
          <span>When</span>
          <WhenConditionInput
            value={when}
            disabled={disabled}
            onChange={setWhen}
          />
        </div>
        <ShortcutArgsEditor
          argFields={argFields}
          argValues={argValues}
          argsText={argsText}
          disabled={disabled}
          structuredArgs={structuredArgs}
          onArgValueChange={updateArgValue}
          onArgsTextChange={setArgsText}
        />
        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={disabled}
            onClick={validateAndApply}
          >
            Apply
          </Button>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

function WhenConditionInput({
  disabled,
  value,
  onChange,
}: {
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [cursorIndex, setCursorIndex] = useState(value.length);
  const completions = focused
    ? matchingWhenCompletions(value, cursorIndex)
    : [];

  function updateCursor(input: HTMLInputElement): void {
    setCursorIndex(input.selectionStart ?? input.value.length);
  }

  function applyCompletion(completion: string): void {
    const next = completeWhenExpression({
      completion,
      cursorIndex,
      value,
    });
    onChange(next.value);
    setCursorIndex(next.cursorIndex);
  }

  return (
    <div className="relative">
      <Input
        aria-label="When"
        value={value}
        disabled={disabled}
        placeholder="selectedWorktree && !inputFocus"
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          updateCursor(event.currentTarget);
        }}
        onClick={(event) => updateCursor(event.currentTarget)}
        onFocus={(event) => {
          setFocused(true);
          updateCursor(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (
            completions.length === 0 ||
            (event.key !== "Tab" && event.key !== "Enter")
          ) {
            return;
          }
          event.preventDefault();
          applyCompletion(completions[0].value);
        }}
        onKeyUp={(event) => updateCursor(event.currentTarget)}
      />
      {completions.length > 0 ? (
        <div className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
          {completions.map((completion) => (
            <button
              key={completion.value}
              type="button"
              className="flex w-full min-w-0 flex-col rounded-sm px-2 py-1 text-left hover:bg-accent"
              onClick={() => applyCompletion(completion.value)}
              onMouseDown={(event) => event.preventDefault()}
            >
              <span className="truncate font-mono text-xs text-popover-foreground">
                {completion.value}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {completion.description}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ShortcutArgsEditor({
  argFields,
  argValues,
  argsText,
  disabled,
  structuredArgs,
  onArgValueChange,
  onArgsTextChange,
}: {
  argFields: readonly CommandArgField[];
  argValues: CommandArgFieldValues;
  argsText: string;
  disabled: boolean;
  structuredArgs: boolean;
  onArgValueChange: (key: string, value: string) => void;
  onArgsTextChange: (value: string) => void;
}) {
  if (!structuredArgs) {
    return (
      <label className="grid gap-1 text-xs text-muted-foreground">
        Args JSON
        <textarea
          value={argsText}
          disabled={disabled}
          placeholder='{"url":"http://localhost:5173"}'
          className="min-h-16 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          onChange={(event) => onArgsTextChange(event.currentTarget.value)}
        />
      </label>
    );
  }

  if (argFields.length === 0) {
    return (
      <div className="grid content-start gap-1 text-xs text-muted-foreground">
        <span>Args</span>
        <span className="rounded-md border border-dashed px-3 py-2">
          This command has no shortcut arguments.
        </span>
      </div>
    );
  }

  return (
    <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
      {argFields.map((field) => (
        <CommandArgInput
          key={field.key}
          disabled={disabled}
          field={field}
          value={argValues[field.key] ?? ""}
          onChange={(value) => onArgValueChange(field.key, value)}
        />
      ))}
    </div>
  );
}

function CommandArgInput({
  disabled,
  field,
  value,
  onChange,
}: {
  disabled: boolean;
  field: CommandArgField;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="grid gap-1">
        {field.label}
        <Select
          value={value || unsetSelectValue}
          disabled={disabled}
          onValueChange={(nextValue) =>
            onChange(nextValue === unsetSelectValue ? "" : nextValue)
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={unsetSelectValue}>Unset</SelectItem>
            <SelectItem value="true">True</SelectItem>
            <SelectItem value="false">False</SelectItem>
          </SelectContent>
        </Select>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <label className="grid gap-1">
        {field.label}
        <Select
          value={value || unsetSelectValue}
          disabled={disabled}
          onValueChange={(nextValue) =>
            onChange(nextValue === unsetSelectValue ? "" : nextValue)
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={unsetSelectValue}>Unset</SelectItem>
            {field.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    );
  }

  return (
    <label className="grid gap-1">
      {field.label}
      <Input
        value={value}
        disabled={disabled}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function CommandShortcutRowView({
  advancedOpen,
  disabled,
  tableRow,
  onAdd,
  onDisableDefaults,
  onEdit,
  onRemove,
  onReset,
  onToggleAdvanced,
  onUpdateAdvanced,
}: {
  advancedOpen: boolean;
  disabled: boolean;
  tableRow: ShortcutTableRow;
  onAdd: (command: CommandId) => void;
  onDisableDefaults: (command: CommandId) => void;
  onEdit: (target: RecordingTarget) => void;
  onRemove: (entryIndex: number) => void;
  onReset: (command: CommandId) => void;
  onToggleAdvanced: (entryIndex: number) => void;
  onUpdateAdvanced: (
    entryIndex: number,
    when: string,
    args: JsonValue | undefined,
  ) => void;
}) {
  const { binding, command, hasCustomizations } = tableRow;
  const source =
    binding?.source === "default"
      ? "System"
      : binding?.source === "user"
        ? "User"
        : "";
  const when = binding?.when?.trim() ? binding.when : "";
  const canShowAdvanced = binding?.entryIndex !== undefined;
  const hasMenuActions =
    binding?.entryIndex !== undefined ||
    binding?.source === "default" ||
    hasCustomizations;

  function editCurrentBinding(): void {
    if (!binding) {
      return;
    }
    onEdit({
      command: command.id,
      disableDefaults: binding.source === "default",
      entryIndex: binding.entryIndex,
    });
  }

  return (
    <div data-testid={`keybinding-row:${command.id}`}>
      <div
        className={cn(
          shortcutTableGridClass,
          "group min-h-10 px-3 py-1.5 text-sm odd:bg-muted/20 even:bg-muted/40 hover:bg-accent/50",
          advancedOpen ? "" : "border-b",
        )}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            {command.icon ? (
              <command.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : null}
            <span className="truncate font-medium">{command.title}</span>
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {command.id}
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          {binding ? (
            <button
              type="button"
              className="inline-flex max-w-full items-center truncate rounded border bg-background px-1.5 py-0.5 font-mono text-xs shadow-xs outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
              disabled={disabled}
              aria-label={`Edit shortcut ${binding.formattedKey} for ${command.title}`}
              onClick={editCurrentBinding}
            >
              {binding.formattedKey}
            </button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={`Add shortcut for ${command.title}`}
            onClick={() => onAdd(command.id)}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          {canShowAdvanced ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={`${advancedOpen ? "Hide" : "Show"} advanced for ${binding.formattedKey} on ${command.title}`}
              onClick={() => onToggleAdvanced(binding.entryIndex!)}
            >
              <ChevronDown
                className={cn(
                  "h-3 w-3 transition-transform",
                  advancedOpen ? "rotate-180" : "",
                )}
              />
            </Button>
          ) : null}
          {when ? (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {when}
            </span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">{source}</div>
        <div className="flex min-w-0 justify-end">
          {hasMenuActions ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled}
                  aria-label={`More actions for ${command.title}`}
                >
                  <MoreHorizontal className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {binding?.entryIndex !== undefined ? (
                  <DropdownMenuItem
                    onClick={() => onRemove(binding.entryIndex!)}
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove
                  </DropdownMenuItem>
                ) : null}
                {binding?.source === "default" ? (
                  <DropdownMenuItem
                    onClick={() => onDisableDefaults(command.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                    Disable
                  </DropdownMenuItem>
                ) : null}
                {hasCustomizations ? (
                  <DropdownMenuItem onClick={() => onReset(command.id)}>
                    <RotateCcw className="h-3 w-3" />
                    Reset
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      {binding?.entryIndex !== undefined && advancedOpen ? (
        <ShortcutAdvancedPanel
          key={`advanced:${binding.entryIndex}:${binding.when ?? ""}:${JSON.stringify(binding.args ?? null)}`}
          binding={binding}
          disabled={disabled}
          onApply={(when, args) =>
            onUpdateAdvanced(binding.entryIndex!, when, args)
          }
        />
      ) : null}
    </div>
  );
}

function KeyboardShortcutsSettingsInner({
  keybindings,
  replaceUserKeybindings,
  status,
}: {
  keybindings: EditableKeybindingEntry[];
  replaceUserKeybindings: (
    keybindings: EditableKeybindingEntry[],
  ) => Promise<unknown>;
  status: KeybindingsStatus;
}) {
  const [draft, setDraft] = useState<EditableKeybindingEntry[]>(keybindings);
  const [query, setQuery] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [recordingTarget, setRecordingTarget] =
    useState<RecordingTarget | null>(null);
  const [recordedKey, setRecordedKey] = useState("");
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [advancedEntryIndex, setAdvancedEntryIndex] = useState<number | null>(
    null,
  );
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!recordingTarget) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      event.preventDefault();
      event.stopPropagation();
      const key = event.key.toLowerCase();
      if (key === "escape") {
        setRecordingTarget(null);
        return;
      }
      if (key === "backspace" || key === "delete") {
        setRecordedKey("");
        setRecordingError(null);
        return;
      }
      if (["alt", "control", "meta", "shift"].includes(key)) {
        return;
      }

      const next = keybindingFromEvent(event);
      if (isReservedKeybinding(next)) {
        setRecordingError("That shortcut is reserved by the browser.");
        return;
      }
      setRecordedKey(next);
      setRecordingError(null);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingTarget]);

  const rows = useMemo(() => buildCommandShortcutRows(draft), [draft]);
  const validation = useMemo(() => validateKeybindingDraft(draft), [draft]);
  const filteredRows = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return needle
      ? rows.filter((row) => row.searchText.includes(needle))
      : rows;
  }, [deferredQuery, rows]);
  const tableRows = useMemo<ShortcutTableRow[]>(() => {
    return filteredRows.flatMap<ShortcutTableRow>((row) => {
      const hasCustomizations =
        row.userBindings.length > 0 || row.hasDefaultOverrides;
      const bindings = [...row.defaultBindings, ...row.userBindings];

      if (bindings.length === 0) {
        return [
          {
            binding: null,
            command: row.command,
            hasCustomizations,
            id: `${row.command.id}:empty`,
            row,
          } satisfies ShortcutTableRow,
        ];
      }

      return bindings.map(
        (binding, index) =>
          ({
            binding,
            command: row.command,
            hasCustomizations,
            id: [
              row.command.id,
              binding.source,
              binding.entryIndex ?? binding.key,
              binding.when ?? "",
              index,
            ].join(":"),
            row,
          }) satisfies ShortcutTableRow,
      );
    });
  }, [filteredRows]);
  const dirty = !sameKeybindings(draft, keybindings);
  const blocked =
    status.writesBlocked ||
    saving ||
    validation.errors.length > 0 ||
    validation.conflicts.length > 0 ||
    validation.duplicates.length > 0;

  function openRecorder(target: RecordingTarget): void {
    setRecordingTarget(target);
    setRecordedKey("");
    setRecordingError(null);
  }

  function applyRecordedKey(): void {
    if (!recordingTarget || !recordedKey) {
      return;
    }
    setDraft((current) => {
      if (recordingTarget.entryIndex !== undefined) {
        return replaceUserShortcut({
          entryIndex: recordingTarget.entryIndex,
          key: recordedKey,
          keybindings: current,
        });
      }
      const base = recordingTarget.disableDefaults
        ? disableCommandDefaults(current, recordingTarget.command)
        : current;
      return addUserShortcut({
        command: recordingTarget.command,
        key: recordedKey,
        keybindings: base,
      });
    });
    setRecordingTarget(null);
  }

  async function saveDraft(): Promise<void> {
    setSaving(true);
    setSaveError(null);
    try {
      await replaceUserKeybindings(draft);
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Keybindings failed to save.",
      );
    } finally {
      setSaving(false);
    }
  }

  const recordedLabel = recordedKey ? formatKeybinding(recordedKey) : null;

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Keyboard className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Keyboard Shortcuts</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => setDraft(keybindings)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Revert
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || blocked}
            onClick={() => void saveDraft()}
          >
            <Save className="h-3.5 w-3.5" />
            Save
          </Button>
        </div>
      </div>

      <KeybindingsStatusNotice status={status} />

      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          placeholder="Search commands..."
          className="pl-8"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {saveError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {saveError}
        </div>
      ) : null}
      {validation.errors.length > 0 ||
      validation.conflicts.length > 0 ||
      validation.duplicates.length > 0 ? (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="h-4 w-4" />
            Resolve shortcut issues before saving
          </div>
          {validation.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
          {validation.conflicts.map((conflict) => (
            <p key={`conflict:${conflict.key}:${conflict.when}`}>
              {formatKeybinding(conflict.key)} conflicts for{" "}
              {shortcutNames(conflict.bindings)}.
            </p>
          ))}
          {validation.duplicates.map((duplicate) => (
            <p key={`duplicate:${duplicate.key}:${duplicate.when}`}>
              {formatKeybinding(duplicate.key)} is duplicated for{" "}
              {shortcutNames(duplicate.bindings)}.
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border">
        <div className="h-full min-h-0 w-full overflow-x-auto">
          <div className="flex h-full min-w-[720px] flex-col">
            <div
              className={cn(
                shortcutTableGridClass,
                "shrink-0 border-b bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground",
              )}
            >
              <div>Command</div>
              <div>Keybinding</div>
              <div>When</div>
              <div>Source</div>
              <div className="text-right">Actions</div>
            </div>
            <div
              data-testid="keybinding-table-scroll"
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {tableRows.map((tableRow) => (
                <CommandShortcutRowView
                  key={tableRow.id}
                  advancedOpen={
                    tableRow.binding?.entryIndex !== undefined &&
                    advancedEntryIndex === tableRow.binding.entryIndex
                  }
                  tableRow={tableRow}
                  disabled={status.writesBlocked || saving}
                  onAdd={(command) =>
                    openRecorder({ command, disableDefaults: false })
                  }
                  onDisableDefaults={(command) =>
                    setDraft((current) =>
                      disableCommandDefaults(current, command),
                    )
                  }
                  onEdit={openRecorder}
                  onRemove={(entryIndex) => {
                    setAdvancedEntryIndex((current) =>
                      current === entryIndex ? null : current,
                    );
                    setDraft((current) =>
                      removeUserShortcut(current, entryIndex),
                    );
                  }}
                  onReset={(command) => {
                    setAdvancedEntryIndex(null);
                    setDraft((current) =>
                      resetCommandKeybindings(current, command),
                    );
                  }}
                  onToggleAdvanced={(entryIndex) =>
                    setAdvancedEntryIndex((current) =>
                      current === entryIndex ? null : entryIndex,
                    )
                  }
                  onUpdateAdvanced={(entryIndex, when, args) =>
                    setDraft((current) =>
                      updateUserShortcutAdvanced({
                        args,
                        entryIndex,
                        keybindings: current,
                        when,
                      }),
                    )
                  }
                />
              ))}
              {tableRows.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No commands found.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={recordingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRecordingTarget(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Shortcut</DialogTitle>
            <DialogDescription>
              Press the key combination to assign to this command.
            </DialogDescription>
          </DialogHeader>
          <div
            className={cn(
              "flex min-h-24 items-center justify-center rounded-md border border-dashed bg-muted/30",
              recordingError ? "border-destructive/50" : "border-border",
            )}
          >
            {recordedLabel ? (
              <kbd className="rounded-md border bg-background px-3 py-2 font-mono text-sm shadow-xs">
                {recordedLabel}
              </kbd>
            ) : (
              <span className="text-sm text-muted-foreground">
                Waiting for keys...
              </span>
            )}
          </div>
          {recordingError ? (
            <p className="text-sm text-destructive">{recordingError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRecordingTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!recordedKey || !!recordingError}
              onClick={applyRecordedKey}
            >
              Save Shortcut
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
