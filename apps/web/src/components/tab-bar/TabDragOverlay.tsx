import { useMemo } from "react";
import SortableTabView from "./SortableTabView";
import { useThemeSettings } from "@/lib/stores/theme";
import { useTerminalSettings } from "@/lib/stores/terminal";
import { useWorktreeFileManagerStore } from "@/lib/stores/worktreeFileManager";
import { presentTab } from "@/lib/tabPresentation";
import type { Tab } from "@/lib/types";

type Props = {
  worktreeId: string;
  tab: Tab;
  width: number | null;
  isActive: boolean;
  paneFocused: boolean;
};

export default function TabDragOverlay({
  worktreeId,
  tab,
  width,
  isActive,
  paneFocused,
}: Props) {
  const theme = useThemeSettings((state) => state.activeTheme);
  const tabLabelMode = useTerminalSettings(
    (state) => state.settings.tabLabelMode,
  );
  const gitStatus = useWorktreeFileManagerStore(
    (state) => state.worktrees[worktreeId]?.gitStatus ?? null,
  );
  const presentation = useMemo(
    () => presentTab(tab, theme, gitStatus, tabLabelMode),
    [gitStatus, tab, tabLabelMode, theme],
  );

  return (
    <SortableTabView
      tabId={tab.id}
      label={presentation.label}
      labelSuffix={presentation.labelSuffix}
      statusLabel={presentation.statusLabel}
      title={presentation.title ?? tab.label}
      iconKind={presentation.iconKind}
      iconPath={presentation.iconPath}
      iconId={presentation.iconId}
      toneClass={presentation.toneClass}
      isActive={isActive}
      paneFocused={paneFocused}
      preview={tab.preview}
      notification={tab.type === "terminal" && !!tab.has_notification}
      isOverlay
      showCloseButton
      width={width}
      onCloseTab={() => {}}
      className="pointer-events-none opacity-100 drop-shadow-lg"
    />
  );
}
