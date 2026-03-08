import { GitFork, Monitor, Paintbrush } from "lucide-react";

export const sections = [
  { name: "Appearance", icon: Paintbrush },
  { name: "Terminal", icon: Monitor },
  { name: "Worktrees", icon: GitFork },
] as const;

export type SectionName = (typeof sections)[number]["name"];

export type SettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
