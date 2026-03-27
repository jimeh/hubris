# Feature 001: Diff Line Stats -- Spec

## Summary

The Changes sidebar currently shows file status badges (M, A, D, etc.) but
gives no indication of change magnitude. This feature adds per-file
insertion/deletion counts (`+N -M`) to every file entry in the sidebar, plus
aggregate totals on each section header (Staged / Unstaged).

The backend computes per-file line stats during git-status reads using
`git2` patch diffing, attaches them as nullable fields on the existing
`GitFileChange` struct, and the frontend renders them inline. The same
struct is shared with commit-details, where the stats fields stay null.

## Data Model Changes

### Rust: `GitFileChange` (crates/server/src/api/worktrees.rs)

Add two nullable fields:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, TS)]
pub struct GitFileChange {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub change_type: GitFileChangeType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub insertions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deletions: Option<usize>,
}
```

These are `Option<usize>` so that:
- `None` means "stats not computed" (commit-details, binary files, >1 MB
  files, conflicted files, errors).
- `Some(0)` means "computed, zero changes" (e.g. pure rename).

### TypeScript: Generated contract (after `mise run generate`)

The generated OpenAPI schema and `rest.generated.ts` will gain:

```typescript
GitFileChange: {
  change_type: components["schemas"]["GitFileChangeType"];
  original_path?: string | null;
  path: string;
  insertions?: number | null;
  deletions?: number | null;
};
```

The existing `WorktreeGitFileChange` type alias in `api.ts` picks this up
automatically.

## Backend Changes

### Stat computation: `crates/server/src/git.rs`

#### New constant

```rust
const DIFF_STAT_MAX_BLOB_BYTES: u64 = 1_048_576; // 1 MB
```

#### New function: `compute_diff_line_stats`

Signature:

```rust
fn compute_diff_line_stats(
    diff: &git2::Diff<'_>,
) -> HashMap<String, (usize, usize)>
```

Iterates over each delta in the diff. For each delta:
1. Skip if status is `Conflicted`, `Ignored`, `Unmodified`.
2. Skip if either old or new file is a tree (directory entry).
3. Skip if new file (or old file for deletes) blob size exceeds
   `DIFF_STAT_MAX_BLOB_BYTES`.
4. Skip binary files: check `new_file.is_binary()` and
   `old_file.is_binary()` on the diff file entries; also guard against
   `Patch::from_diff` returning a binary indication.
5. Create a `Patch` via `git2::Patch::from_diff(diff, delta_index)`.
   If it fails, skip this delta (graceful degradation).
6. Extract `patch.line_stats()` -> `(context, additions, deletions)`.
7. Key by the path that `map_diff_delta` would use for that delta status
   (new file path for adds/modifies/renames/copies, old file path for
   deletes).

Returns a `HashMap<String, (usize, usize)>` mapping path to
`(insertions, deletions)`.

#### New function: `attach_line_stats`

Signature:

```rust
fn attach_line_stats(
    changes: &mut [GitFileChange],
    stats: &HashMap<String, (usize, usize)>,
)
```

For each `GitFileChange` in the slice, looks up its `path` in `stats`.
If found, sets `insertions = Some(ins)` and `deletions = Some(del)`.
For typechange entries, leave stats as `None` (skip lookup).

#### Modified: `map_diff_delta`

Update to initialize the new fields as `None`:

```rust
Some(GitFileChange {
    path,
    original_path,
    change_type,
    insertions: None,
    deletions: None,
})
```

#### Modified: `read_staged_files`

After `diff.find_similar(...)` and before `collect_diff_changes(...)`:
1. Call `compute_diff_line_stats(&diff)` to get the stats map.
2. After collecting changes, call `attach_line_stats(&mut changes, &stats)`.

#### Modified: `read_unstaged_files`

Same pattern as `read_staged_files`: compute stats from the diff, attach
them to the collected changes.

#### NOT modified: `read_commit_details_git2`

This function also uses `collect_diff_changes` but must NOT compute stats.
The `insertions`/`deletions` fields remain `None` in commit-details
responses. This is already satisfied since `collect_diff_changes` returns
changes with `None` stats and we only call `attach_line_stats` in the
staged/unstaged paths.

### No caching changes needed

Stats are computed inline during git-status reads, which are already cached
by `WorktreeFileTracker::git_cache` in `worktree_files.rs`. The
`CachedGitStatus` stores `git::WorktreeGitStatus` which contains
`Vec<GitFileChange>`, so the new fields ride along for free.

## Frontend Changes

### New component: `DiffLineStats`

File: `frontend/src/components/DiffLineStats.tsx`

A small presentational component that renders the `+N -M` indicator.

```typescript
type DiffLineStatsProps = {
  insertions: number | null | undefined;
  deletions: number | null | undefined;
};
```

Behavior:
- If both `insertions` and `deletions` are nullish or both are zero,
  render nothing (return `null`).
- If `insertions > 0`, render `<span className="text-emerald-500">+{formatted}</span>`.
- If `deletions > 0`, render `<span className="text-rose-500">-{formatted}</span>`.
- When zero, that portion is hidden entirely (not `+0` or `-0`).
- Numbers >= 1000 use `Intl.NumberFormat` with locale grouping
  (e.g. `+12,345`).
- The wrapper element uses a smaller text size than filenames:
  `text-[11px] tabular-nums` (filenames are `text-[13px]`).
- Gap between `+N` and `-M` portions: a single space character or
  `gap-1.5` flex gap.

### New utility: `formatDiffStat`

File: `frontend/src/lib/diffLineStats.ts`

```typescript
export function formatDiffStat(value: number): string
```

Formats a number with locale-style comma separators using
`new Intl.NumberFormat().format(value)`.

```typescript
export function computeAggregateStats(
  changes: WorktreeGitFileChange[],
): { insertions: number; deletions: number }
```

Sums `insertions` and `deletions` across all changes, treating nullish
values as 0.

### Modified: `FilePathRow` component

In `WorktreeGitStatusPanel.tsx`, add the `DiffLineStats` component between
the filename/directory-path area and the action buttons area. It sits inside
the `ChangeRowFrame`'s `primary` slot, after the filename grid span.

Alternatively, it can be placed as a new slot or appended after the filename
span within the existing grid. The key constraint: it must appear after the
filename and be visually smaller.

### Modified: `TreeFileNode` component

Same treatment as `FilePathRow` -- show `DiffLineStats` after the filename.

### Modified: `TreeDirectoryNode` component

Directory nodes do NOT show stats (per evals). No changes needed here.

### Modified: `StatusFileSection` component

Add aggregate `DiffLineStats` to the section header button, after the
`Badge` (file count). Use `computeAggregateStats(changes)` to derive the
totals. The aggregate stats render in the same `+N -M` format with the
same zero-hiding and color rules. They remain visible when the section is
collapsed because they are in the trigger header, outside `CollapsibleContent`.

The aggregate computation uses `useMemo` keyed on `changes` -- no
`useEffect` needed since this derives directly from props.

### NOT modified: Commit tree nodes

`CommitTreeFileNode` and `CommitTreeDirectoryNode` are for commit-details
file lists, which won't have stats. The `DiffLineStats` component handles
null gracefully (renders nothing), so even if passed, it would be invisible.
But we simply don't add it to commit tree nodes.

## Integration Points

- **Contract generation**: After modifying `GitFileChange` in Rust, run
  `mise run generate` to update `openapi.generated.json` and
  `rest.generated.ts`.
- **SSE/state sync**: `GitFileChange` is part of
  `WorktreeGitStatusResponse` served via the REST git-status endpoint.
  No SSE schema changes needed -- SSE doesn't carry file-level git status
  directly (it triggers re-fetches via events).
- **Zustand stores**: No store changes needed. The worktree file manager
  store already fetches and caches `WorktreeGitStatus` which includes
  `GitFileChange[]`. The new fields flow through automatically.
- **Tab presentation**: `tabPresentation.ts` uses `WorktreeGitFileChange`
  for diff tab badge display but doesn't need line stats.

## Questions / Assumptions

1. **Blob size check approach**: The evals say "files larger than 1 MB are
   skipped." The most reliable way to check blob size in `git2` is from
   the `DiffFile::size()` on each delta's old/new files. This avoids
   loading blob content just to measure it. I'll check both old and new
   file sizes -- if either exceeds 1 MB, skip.

2. **Binary detection**: `git2::DiffFile` has an `is_binary()` method, and
   `Patch::from_diff` may also signal binary via the patch hunk content.
   Both are checked.

3. **Stats for untracked (new) files**: The unstaged diff
   (`diff_index_to_workdir`) with `include_untracked(true)` shows new
   files as adds with their full content, so `Patch::from_diff` will
   naturally report all lines as insertions. A 200-line new file will
   show `+200`.

4. **Stats for typechange**: The evals explicitly say "Given a typechange
   file, then no stats are shown." I will skip attaching stats for
   `Typechange` entries.

5. **Conflicted files**: Skipped in stat computation per evals. They often
   have conflict markers that would produce misleading stats.

6. **Performance**: `Patch::from_diff` iterates hunks per-delta. For
   typical working-tree diffs (tens of files), this is negligible. The
   1 MB blob-size cutoff bounds worst-case cost. The computation runs
   inside the existing `spawn_blocking` context alongside the diff itself.
