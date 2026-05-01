import {
  Code2,
  GitFork,
  Keyboard,
  Monitor,
  Paintbrush,
  Terminal,
} from "lucide-react";

export const sections = [
  { name: "Appearance", icon: Paintbrush },
  { name: "Editor", icon: Code2 },
  { name: "Terminal", icon: Terminal },
  { name: "Keyboard Shortcuts", icon: Keyboard },
  { name: "VS Code", icon: Monitor },
  { name: "Worktrees", icon: GitFork },
] as const;

export type SectionName = (typeof sections)[number]["name"];

export type SettingsDialogProps = {
  initialSection?: SectionName;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
