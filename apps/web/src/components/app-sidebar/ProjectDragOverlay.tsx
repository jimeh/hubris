import type { Project, Worktree } from "@/lib/types";
import ProjectPreview from "./ProjectPreview";

export default function ProjectDragOverlay({
  project,
  isExpanded,
  projectError: currentProjectError,
  worktrees,
  selectedWorktreeId,
  width,
}: {
  project: Project;
  isExpanded: boolean;
  projectError: string | null;
  worktrees: Worktree[];
  selectedWorktreeId: string | null;
  width: number | null;
}) {
  return (
    <div
      className="group/menu-item rounded-lg opacity-60"
      style={width === null ? undefined : { width }}
    >
      <ProjectPreview
        project={project}
        isExpanded={isExpanded}
        projectError={currentProjectError}
        worktrees={worktrees}
        selectedWorktreeId={selectedWorktreeId}
      />
    </div>
  );
}
