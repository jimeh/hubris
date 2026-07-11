import {
  Code2,
  FlaskConical,
  GitFork,
  Keyboard,
  Monitor,
  Paintbrush,
  Terminal,
} from "lucide-react";
import type { SectionName } from "@/lib/settingsSections";

export const sections = [
  { name: "Appearance", icon: Paintbrush },
  { name: "Editor", icon: Code2 },
  { name: "Terminal", icon: Terminal },
  { name: "Keyboard Shortcuts", icon: Keyboard },
  { name: "VS Code", icon: Monitor },
  { name: "Worktrees", icon: GitFork },
  { name: "Experimental", icon: FlaskConical },
] as const;

export type { SectionName } from "@/lib/settingsSections";

export type SettingsDialogProps = {
  initialSection?: SectionName;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
