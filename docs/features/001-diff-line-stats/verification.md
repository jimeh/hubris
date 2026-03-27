# Verification Results -- Feature 001: Diff Line Stats in Changes Sidebar

**Date:** 2026-03-26
**Verified by:** verifier agent
**Overall:** PASS

## Acceptance Criteria

### Each file entry in the Changes sidebar shows an added/removed indicator after the filename

**Result:** PASS
**Method:** code inspection
**Evidence:** `DiffLineStats` component is rendered in both `FilePathRow` (list
view, line 508-511 of WorktreeGitStatusPanel.tsx) and `TreeFileNode` (tree view,
line 617-620). Both pass `change.insertions` and `change.deletions` as props.

### Format is `+N -M` where N is lines added and M is lines removed

**Result:** PASS
**Method:** code inspection + automated test
**Evidence:** `DiffLineStats.tsx` renders `+{formatDiffStat(ins)}` and
`-{formatDiffStat(del)}` in separate spans. Tests in `DiffLineStats.test.tsx`
confirm `+10` and `-5` render correctly.

### When either count is zero, that portion is hidden entirely

**Result:** PASS
**Method:** code inspection + automated test
**Evidence:** Component renders insertions only when `ins > 0` and deletions
only when `del > 0`. Tests "renders only insertions when deletions are null",
"renders only deletions when insertions are null", and "renders only deletions
when insertions are zero" all pass.

### When both counts are zero, no stats indicator is shown at all

**Result:** PASS
**Method:** code inspection + automated test
**Evidence:** Component returns `null` when `ins === 0 && del === 0`. Tests
"renders nothing when both values are null" and "renders nothing when both
values are zero" pass. Integration test "hides stats when both insertions and
deletions are zero" confirms no `+0` or `-0` in the DOM.

### The `+N` portion (including the `+`) is green

**Result:** PASS
**Method:** code inspection
**Evidence:** Insertions span uses `className="text-emerald-500"`, which
renders green (#10b981).

### The `-M` portion (including the `-`) is red

**Result:** PASS
**Method:** code inspection
**Evidence:** Deletions span uses `className="text-rose-500"`, which renders
red (#f43f5e).

### Numbers >= 1,000 are formatted with locale-style comma separators

**Result:** PASS
**Method:** code inspection + automated test
**Evidence:** `formatDiffStat` uses `new Intl.NumberFormat().format(value)`.
Tests confirm `formatDiffStat(1000)` produces `"1,000"` and
`formatDiffStat(12345)` produces `"12,345"`. The component test also verifies
`+12,345` and `-6,789` render correctly.

### The indicator text is visually smaller than the filename

**Result:** PASS
**Method:** code inspection
**Evidence:** `DiffLineStats` wrapper uses `text-[11px]`. Filenames in both
`FilePathRow` (line 494) and `TreeFileNode` (line 614) use `text-[13px]`.
11px < 13px.

### The staged section header shows aggregate `+N -M` summing all files in that section

**Result:** PASS
**Method:** code inspection + automated test
**Evidence:** `ChangeSection` component computes
`computeAggregateStats(changes)` and passes the result to `DiffLineStats` on
the section header (line 875-878). Integration test "shows aggregate stats on
section headers" verifies `+28` and `-4` for staged files.

### The unstaged section header shows aggregate `+N -M` summing all files in that section

**Result:** PASS
**Method:** code inspection + automated test
**Evidence:** Same `ChangeSection` component used for both sections. Integration
test verifies `+18` and `-3` for unstaged files (sums of 5+10+3+0 and
2+0+1+0).

### Aggregate stats on section headers remain visible when the section is collapsed

**Result:** PASS
**Method:** code inspection + automated test
**Evidence:** `DiffLineStats` is rendered inside the `CollapsibleTrigger` button
area, outside `CollapsibleContent`. Integration test "keeps aggregate stats
visible when section is collapsed" collapses Staged, confirms `README.md`
disappears but `+28` remains.

### Stats appear in both list view and tree view modes

**Result:** PASS
**Method:** code inspection
**Evidence:** `DiffLineStats` rendered in `FilePathRow` (list view, line 508)
and `TreeFileNode` (tree view, line 617). `TreeDirectoryNode` intentionally
does NOT render stats -- only leaf file entries do, which is also correct per
eval edge case 5.

### Backend API provides per-file insertions/deletions as part of the git status response

**Result:** PASS
**Method:** code inspection
**Evidence:** `GitFileChange` struct (worktrees.rs lines 118-120) has
`insertions: Option<usize>` and `deletions: Option<usize>` with
`skip_serializing_if = "Option::is_none"`. Generated OpenAPI schema shows them
as `["integer", "null"]`. Generated TypeScript type has
`deletions?: number | null` and `insertions?: number | null`.

### Stats update when files are staged/unstaged/refreshed

**Result:** PASS
**Method:** code inspection
**Evidence:** Stats come from the git status API response, which is re-fetched
on stage/unstage/refresh actions. The `ChangeSection` component recomputes
aggregate stats via `useMemo` keyed on `changes`. When the API returns new
data, both per-file and aggregate stats update reactively.

### New/untracked files show their full line count as additions

**Result:** PASS
**Method:** code inspection
**Evidence:** In `compute_diff_line_stats` (git.rs line 645),
`Delta::Untracked` is handled the same as `Delta::Added` -- stats are computed
via `Patch::from_diff` which counts all lines as additions. It is not skipped
in the match at line 607-610.

### Conflicted files do not show stats

**Result:** PASS
**Method:** code inspection
**Evidence:** `compute_diff_line_stats` explicitly skips `Delta::Conflicted`
at line 608. No stats are computed or attached for conflicted files.

### Files larger than 1 MB are skipped for stat computation

**Result:** PASS
**Method:** code inspection
**Evidence:** `DIFF_STAT_MAX_BLOB_BYTES` is set to `1_048_576` (1 MB) at line
592. Lines 621-624 skip any delta where `old_file.size()` or `new_file.size()`
exceeds this limit.

### Binary files do not show stats

**Result:** PASS
**Method:** code inspection
**Evidence:** Two layers of protection: (1) `is_binary()` check at lines
627-629 skips binary files before patch creation; (2) `Patch::from_diff`
returning `Ok(None)` at line 634 also catches binaries.

## Constraints

### Backend must use git2 (libgit2), not the git CLI

**Result:** PASS
**Method:** code inspection
**Evidence:** `compute_diff_line_stats` uses `git2::Patch::from_diff` and
`patch.line_stats()` -- entirely libgit2-based.

### Stat computation uses Patch::from_diff or diff.stats()

**Result:** PASS
**Method:** code inspection
**Evidence:** Uses `git2::Patch::from_diff(diff, idx)` at line 632, then
`patch.line_stats()` at line 638.

### New fields on GitFileChange must be Option<usize> (nullable)

**Result:** PASS
**Method:** code inspection
**Evidence:** Both fields declared as `Option<usize>` with
`skip_serializing_if = "Option::is_none"` in worktrees.rs lines 117-120.

### GitFileChange is shared with commit-details -- commit-details should NOT compute stats

**Result:** PASS
**Method:** code inspection
**Evidence:** `read_commit_details_git2` (git.rs line 674-714) calls
`collect_diff_changes(&diff)` but does NOT call `compute_diff_line_stats` or
`attach_line_stats`. Fields remain `None` from `map_diff_delta`.

### Must run mise run generate after modifying GitFileChange to regenerate TypeScript contracts

**Result:** PASS
**Method:** code inspection
**Evidence:** Generated files `openapi.generated.json` and `rest.generated.ts`
include `insertions` and `deletions` fields on `GitFileChange`. These files
appear in the uncommitted changes, confirming regeneration was done.

### Do not modify shadcn components under frontend/src/components/ui/

**Result:** PASS
**Method:** code inspection
**Evidence:** The EDD-001 commits (`635d692`, `1c69e43`) do not touch any
files under `frontend/src/components/ui/`. The uncommitted working tree changes
also do not touch that directory.

### Colors must work in both light and dark themes

**Result:** PASS
**Method:** code inspection
**Evidence:** `text-emerald-500` and `text-rose-500` are fixed Tailwind color
utilities that render identically in light and dark modes. These mid-saturation
colors are visible against both white and dark backgrounds.

### Stats are display-only -- no new user interactions

**Result:** PASS
**Method:** code inspection
**Evidence:** `DiffLineStats` component renders plain `<span>` elements with
no click handlers, no hover effects, no interactive behavior.

## Test Cases Coverage

### Happy Path

| # | Test Case | Covered By | Status |
|---|-----------|-----------|--------|
| 1 | 3 modified files show stats + header sum | "shows per-file diff line stats in list view" + "shows aggregate stats on section headers" | PASS |
| 2 | Untracked file shows only `+50` | "renders only insertions when deletions are null" (DiffLineStats) + backend `Untracked` handling | PASS |
| 3 | Deletion-only file shows only `-M` | "renders only deletions when insertions are zero" (DiffLineStats) | PASS |
| 4 | Independent section sums | "shows aggregate stats on section headers" verifies `+18 -3` and `+28 -4` separately | PASS |
| 5 | Staging updates both headers | "updates aggregate stats after staging a file" stages bar.txt, mocks re-fetched status, verifies both headers update | PASS |
| 6 | Large numbers with commas | "formats large numbers with comma separators" (DiffLineStats + formatDiffStat) | PASS |

### Edge Cases

| # | Test Case | Covered By | Status |
|---|-----------|-----------|--------|
| 1 | Rename with no content -- no stats | Backend skips via zero counts; frontend hides when both zero | PASS |
| 2 | Rename with content changes shows delta | Backend computes Patch for `Delta::Renamed` | PASS |
| 3 | Binary file -- no stats | Backend `is_binary()` + `Patch::from_diff` None check | PASS |
| 4 | Empty new file -- no stats | Both counts zero, component returns null | PASS |
| 5 | Directory nodes in tree view -- no stats | `TreeDirectoryNode` does not render `DiffLineStats` | PASS |
| 6 | Conflicted file -- no stats | Backend skips `Delta::Conflicted` | PASS |
| 7 | File > 1 MB -- no stats | Backend `DIFF_STAT_MAX_BLOB_BYTES` check | PASS |
| 8 | Collapsed section still shows aggregate | "keeps aggregate stats visible when section is collapsed" | PASS |
| 9 | Typechange -- no stats | Backend skips `Delta::Typechange` + `attach_line_stats` guard | PASS |
| 10 | All zero stats -- no aggregate | `computeAggregateStats` returns zeros; `DiffLineStats` returns null | PASS |

### Error Cases

| # | Test Case | Covered By | Status |
|---|-----------|-----------|--------|
| 1 | Graceful degradation on stat failure | Backend `Err(_) => continue` at lines 635, 640; frontend handles null | PASS |

## Code Review

### Observations

1. **Uncommitted integration**: The `WorktreeGitStatusPanel.tsx` and
   `WorktreeGitStatusPanel.test.tsx` changes that wire up `DiffLineStats` are
   present in the working tree but not yet committed. The feature is
   functionally complete in the working tree, but the integration commit is
   missing. This is not a functional issue but should be committed.

2. **Locale-dependent test**: `formatDiffStat` uses `new Intl.NumberFormat()`
   without an explicit locale. Tests assert English-locale output (`"1,000"`,
   `"12,345"`). If CI runs in a non-English locale, tests could fail. Consider
   using `new Intl.NumberFormat("en-US")` or making tests locale-aware. Low
   risk in practice since Node.js defaults to `en-US`.

3. **No backend unit tests for stat computation**: `compute_diff_line_stats`
   and `attach_line_stats` are private functions without dedicated unit tests.
   They're only exercised indirectly through the full git status pipeline.
   The frontend tests compensate by verifying the component/formatting layers.

4. **New `Intl.NumberFormat()` allocation per call**: `formatDiffStat` creates
   a new `Intl.NumberFormat` instance on every invocation. For a small number
   of files this is fine, but a cached formatter would be more efficient if
   the file list grows large. Minor performance concern.

5. **No dead code or unused imports detected** in the new files.

6. **No shadcn component modifications** -- constraint satisfied.

7. **No security concerns** -- stats are read-only derived values from git
   diffs with no user input involved.
