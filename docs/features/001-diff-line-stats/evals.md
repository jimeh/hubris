# Feature 001: Diff Line Stats in Changes Sidebar

## Problem

The changes sidebar shows staged/unstaged files with status badges (M, A, D,
etc.) but gives no sense of how much each file changed. Users have to open
each diff to judge the scope of changes. Adding per-file insertion/deletion
counts (like `+12 -6`) provides at-a-glance change magnitude — a common
pattern in tools like `git diff --stat`, GitHub, and VS Code.

## Acceptance Criteria

- [ ] Each file entry in the Changes sidebar shows an added/removed indicator
      after the filename
- [ ] Format is `+N -M` where N is lines added and M is lines removed
- [ ] When either count is zero, that portion is hidden entirely (e.g. a
      pure-add file shows only `+N`, not `+N -0`; a pure-delete shows only
      `-M`)
- [ ] When both counts are zero (e.g. rename with no content change), no
      stats indicator is shown at all
- [ ] The `+N` portion (including the `+`) is green
- [ ] The `-M` portion (including the `-`) is red
- [ ] Numbers >= 1,000 are formatted with locale-style comma separators
      (e.g. `+12,345`)
- [ ] The indicator text is visually smaller than the filename
- [ ] The staged section header shows aggregate `+N -M` summing all files
      in that section (same zero-hiding rules apply)
- [ ] The unstaged section header shows aggregate `+N -M` summing all files
      in that section (same zero-hiding rules apply)
- [ ] Aggregate stats on section headers remain visible when the section is
      collapsed
- [ ] Stats appear in both list view and tree view modes
- [ ] Backend API provides per-file insertions/deletions as part of the git
      status response (`Option<usize>` / nullable fields on `GitFileChange`)
- [ ] Stats update when files are staged/unstaged/refreshed
- [ ] New/untracked files show their full line count as additions (e.g.
      a 200-line new file shows `+200`)
- [ ] Conflicted files do not show stats (too noisy with conflict markers)
- [ ] Files larger than 1 MB are skipped for stat computation (API returns
      null for those files; frontend shows no stats)
- [ ] Binary files do not show stats

## Test Cases

### Happy Path

1. Given a worktree with 3 modified unstaged files, when the Changes sidebar
   opens, then each file shows its `+N -M` stats and the "Unstaged" header
   shows the sum of all three files' stats

2. Given a new untracked file with 50 lines, when shown in the sidebar, then
   it displays `+50` (no `-` portion since removals are zero)

3. Given a file with only deletions (e.g. lines removed from an existing
   file), when shown in the sidebar, then it displays only `-M` (no `+`
   portion since additions are zero)

4. Given staged and unstaged files, when viewing the sidebar, then each
   section header shows independent sums for its own files only

5. Given a file is staged via the sidebar action button, when it moves from
   unstaged to staged, then both section headers update their aggregate stats

6. Given a modified file with 12,345 added lines and 6,789 removed lines,
   then stats render as `+12,345 -6,789`

### Edge Cases

1. Given a renamed file with no content changes, then no stats indicator is
   shown

2. Given a renamed file with content changes (e.g. 5 lines added, 3
   removed), then stats show `+5 -3` (only the content delta, not the full
   file)

3. Given a binary file change, then no stats are shown

4. Given an empty new file (untracked, 0 bytes), then no stats indicator is
   shown (both counts are zero)

5. Given tree view mode with collapsed directory nodes, then directory nodes
   do not show stats (only leaf file entries do)

6. Given a conflicted file, then no stats are shown

7. Given a file larger than 1 MB, then no stats are shown

8. Given a staged section is collapsed, the aggregate stats still display on
   the section header

9. Given a typechange file (e.g. file to symlink), then no stats are shown

10. Given all files in a section have zero stats (e.g. all renames with no
    content changes), then the section header shows no aggregate stats

### Error Cases

1. Given the git status API fails to compute diff stats for a file, then
   the file still renders without stats (graceful degradation — no crash)

## Constraints

- Backend must use `git2` (libgit2), not the git CLI, consistent with
  existing git operations
- Stat computation uses `Patch::from_diff` or `diff.stats()` — skip files
  where the blob exceeds 1 MB to bound computation cost
- Must not add noticeable latency to the git status endpoint
- New fields on `GitFileChange` must be `Option<usize>` (nullable) for
  backward compatibility and to represent "stats not available"
- `GitFileChange` is shared with commit-details API — commit-details should
  NOT compute stats (fields remain null there)
- Must run `mise run generate` after modifying `GitFileChange` to regenerate
  TypeScript contracts
- Do not modify shadcn components under `frontend/src/components/ui/`
- Colors must work in both light and dark themes
- Stats are display-only — no new user interactions

## Out of Scope

- Per-directory aggregate stats in tree view
- Inline diff preview in the sidebar
- Stats for ahead commits or commit-details file lists
- Click-to-navigate from stats to specific diff lines
- Per-file size cutoff UI (no "file too large" indicator — just omit stats)
