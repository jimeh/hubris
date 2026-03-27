# Feature 001: Diff Line Stats -- Tasks

## Tasks

- [x] **Task 1: Add `insertions`/`deletions` fields to `GitFileChange`**
  - Criteria: "Backend API provides per-file insertions/deletions as part of the git status response (`Option<usize>` / nullable fields on `GitFileChange`)"
  - Dependencies: none
  - Parallelizable: no (all subsequent tasks depend on this)
  - Details:
    - In `crates/server/src/api/worktrees.rs`, add two fields to `GitFileChange`:
      ```rust
      #[serde(skip_serializing_if = "Option::is_none")]
      pub insertions: Option<usize>,
      #[serde(skip_serializing_if = "Option::is_none")]
      pub deletions: Option<usize>,
      ```
    - Update `map_diff_delta` in `crates/server/src/git.rs` to initialize both fields as `None` in the returned `GitFileChange`.
    - Run `mise run generate` to regenerate TypeScript contracts.
    - Run `mise run check` to verify compilation.

- [x] **Task 2: Compute and attach line stats in staged/unstaged diff reads**
  - Criteria: "Backend API provides per-file insertions/deletions"; "New/untracked files show their full line count as additions"; "Conflicted files do not show stats"; "Files larger than 1 MB are skipped"; "Binary files do not show stats"; "Stats update when files are staged/unstaged/refreshed"
  - Dependencies: Task 1
  - Parallelizable: no
  - Details:
    - In `crates/server/src/git.rs`:
      - Add `const DIFF_STAT_MAX_BLOB_BYTES: u64 = 1_048_576;`
      - Add `compute_diff_line_stats(diff: &git2::Diff<'_>) -> HashMap<String, (usize, usize)>`:
        - Iterate deltas by index. For each:
          - Skip `Conflicted`, `Ignored`, `Unmodified` statuses.
          - Skip tree entries (`diff_file_is_tree`).
          - Skip if `Typechange` status.
          - Skip if old or new file `size() > DIFF_STAT_MAX_BLOB_BYTES`.
          - Skip if `old_file.is_binary()` or `new_file.is_binary()`.
          - Attempt `git2::Patch::from_diff(diff, idx)`. On failure, skip.
          - If patch is `None` (binary), skip.
          - Call `patch.line_stats()` to get `(context, additions, deletions)`.
          - Key by the same path logic as `map_diff_delta` (new file path for most, old file path for deletes).
        - Return the map.
      - Add `attach_line_stats(changes: &mut [GitFileChange], stats: &HashMap<String, (usize, usize)>)`:
        - For each change, skip if `change_type` is `Typechange`.
        - Look up `change.path` in stats; if found, set `insertions` and `deletions` to `Some(...)`.
      - Modify `read_staged_files`: after `diff.find_similar()`, call `compute_diff_line_stats(&diff)`, then after `collect_diff_changes`, call `attach_line_stats(&mut changes, &stats)`. Return `changes` instead of calling `collect_diff_changes` inline.
      - Modify `read_unstaged_files`: same pattern.
      - Do NOT modify `read_commit_details_git2` -- stats stay `None` there.
    - Add unit tests in the existing `mod tests` block:
      - Test: new untracked file shows full line count as insertions.
      - Test: modified file shows correct insertions/deletions.
      - Test: renamed file with no content changes has `Some(0)` / `Some(0)`.
      - Test: binary file has `None` stats.
    - Run `mise run check` and `cargo test`.

- [x] **Task 3: Create `DiffLineStats` component and formatting utilities**
  - Criteria: "Format is `+N -M`"; "When either count is zero, that portion is hidden"; "When both counts are zero, no stats indicator"; "`+N` portion is green"; "`-M` portion is red"; "Numbers >= 1,000 formatted with comma separators"; "Indicator text is visually smaller than filename"
  - Dependencies: Task 1 (needs generated types)
  - Parallelizable: yes (with Task 2)
  - Details:
    - Create `frontend/src/lib/diffLineStats.ts`:
      - `formatDiffStat(value: number): string` -- uses `new Intl.NumberFormat().format(value)`.
      - `computeAggregateStats(changes: WorktreeGitFileChange[]): { insertions: number; deletions: number }` -- sums `insertions` and `deletions` across all changes, treating nullish as 0.
    - Create `frontend/src/components/DiffLineStats.tsx`:
      - Props: `{ insertions: number | null | undefined; deletions: number | null | undefined }`.
      - Returns `null` if both are nullish or both are zero.
      - Renders `+N` in `text-emerald-500` when insertions > 0.
      - Renders `-M` in `text-rose-500` when deletions > 0.
      - Omits the zero portion entirely.
      - Wrapper: `text-[11px] tabular-nums` with flex gap between portions.
    - Add tests:
      - `frontend/src/lib/diffLineStats.test.ts`:
        - `formatDiffStat(12345)` returns `"12,345"` (or locale equivalent).
        - `computeAggregateStats` sums correctly, handles nullish.
        - `computeAggregateStats` returns `{0, 0}` for all-null stats.
      - `frontend/src/components/DiffLineStats.test.tsx`:
        - Both null -> renders nothing.
        - Both zero -> renders nothing.
        - Only insertions -> renders `+N`, no `-` portion.
        - Only deletions -> renders `-M`, no `+` portion.
        - Both nonzero -> renders `+N -M`.
        - Large number -> uses comma formatting.
    - Run `bun run check` and `bun run test`.

- [x] **Task 4: Integrate stats into file rows (list and tree views)**
  - Criteria: "Each file entry in the Changes sidebar shows an added/removed indicator"; "Stats appear in both list view and tree view modes"; "Directory nodes do not show stats"
  - Dependencies: Task 3
  - Parallelizable: no
  - Details:
    - In `frontend/src/components/WorktreeGitStatusPanel.tsx`:
      - Import `DiffLineStats` from `@/components/DiffLineStats`.
      - **`FilePathRow`**: Add `<DiffLineStats insertions={change.insertions} deletions={change.deletions} />` in the `primary` slot of `ChangeRowFrame`, after the filename/directory-path grid span. Place it as a `shrink-0` element so it doesn't get truncated.
      - **`TreeFileNode`**: Same treatment -- add `DiffLineStats` after the filename span in the `primary` slot.
      - **`TreeDirectoryNode`**: No changes (directories don't show stats per evals).
    - Verify in both list and tree view modes that stats appear on file nodes only.
    - Run `bun run check`.

- [x] **Task 5: Add aggregate stats to section headers**
  - Criteria: "Staged section header shows aggregate `+N -M`"; "Unstaged section header shows aggregate `+N -M`"; "Same zero-hiding rules apply"; "Aggregate stats remain visible when collapsed"
  - Dependencies: Task 3, Task 4
  - Parallelizable: no
  - Details:
    - In `frontend/src/components/WorktreeGitStatusPanel.tsx`:
      - Import `computeAggregateStats` from `@/lib/diffLineStats`.
      - In `StatusFileSection`, compute aggregate stats with `useMemo`:
        ```typescript
        const aggregateStats = useMemo(
          () => computeAggregateStats(changes),
          [changes],
        );
        ```
      - Render `<DiffLineStats insertions={aggregateStats.insertions} deletions={aggregateStats.deletions} />` in the section header button, after the `Badge` element. This is inside the `CollapsibleTrigger`, outside `CollapsibleContent`, so it stays visible when collapsed.
      - When all files in a section have zero stats (e.g. all renames with no content changes), `computeAggregateStats` returns `{0, 0}` and `DiffLineStats` renders nothing.
    - Run `bun run check`.

- [x] **Task 6: Update existing tests for new fields**
  - Criteria: "Given the git status API fails to compute diff stats for a file, then the file still renders without stats (graceful degradation)"
  - Dependencies: Task 4, Task 5
  - Parallelizable: no
  - Details:
    - In `frontend/src/components/WorktreeGitStatusPanel.test.tsx`:
      - Update mock git status responses to include `insertions` and `deletions` fields on `GitFileChange` objects. Existing tests that construct change objects need the new optional fields (they can remain undefined since they're optional).
      - Add a test: given file changes with stats, verify `+N` and `-M` text appears in the rendered output.
      - Add a test: given a renamed file with no content changes (insertions: 0, deletions: 0), verify no stats indicator is rendered.
      - Add a test: given file changes with stats, verify section header shows aggregate totals.
      - Add a test: given a collapsed section with file changes, verify aggregate stats are still visible in the header.
    - In `frontend/src/lib/worktreeGitStatusTree.test.ts`:
      - Update test change objects to include `insertions`/`deletions` (can be undefined or null, just ensuring type compatibility).
    - Run full test suite: `bun run test` and `cargo test`.
    - Run `mise run check`.
