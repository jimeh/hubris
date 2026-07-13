import { describe, expect, it } from "vitest";

import type { WorktreeGitFileChange } from "@/lib/api";

import { computeAggregateStats, formatDiffStat } from "./diffLineStats";

describe("formatDiffStat", () => {
  it("formats zero", () => {
    expect(formatDiffStat(0)).toBe("0");
  });

  it("formats numbers below 1000 without separators", () => {
    expect(formatDiffStat(999)).toBe("999");
  });

  it("formats 1000 with an en-US comma separator", () => {
    expect(formatDiffStat(1000)).toBe("1,000");
  });

  it("formats large numbers with en-US separators", () => {
    expect(formatDiffStat(12345)).toBe("12,345");
  });
});

describe("computeAggregateStats", () => {
  it("returns zeros for an empty array", () => {
    expect(computeAggregateStats([])).toEqual({
      insertions: 0,
      deletions: 0,
    });
  });

  it("sums insertions and deletions across changes", () => {
    const changes: WorktreeGitFileChange[] = [
      {
        path: "a.ts",
        changeType: "modified",
        insertions: 10,
        deletions: 5,
      },
      {
        path: "b.ts",
        changeType: "added",
        insertions: 20,
        deletions: 0,
      },
      {
        path: "c.ts",
        changeType: "modified",
        insertions: null,
        deletions: 3,
      },
    ];
    expect(computeAggregateStats(changes)).toEqual({
      insertions: 30,
      deletions: 8,
    });
  });

  it("treats undefined stats as zero", () => {
    const changes: WorktreeGitFileChange[] = [
      { path: "d.ts", changeType: "renamed" },
      {
        path: "e.ts",
        changeType: "modified",
        insertions: 7,
      },
    ];
    expect(computeAggregateStats(changes)).toEqual({
      insertions: 7,
      deletions: 0,
    });
  });

  it("returns zeros when all stats are null", () => {
    const changes: WorktreeGitFileChange[] = [
      {
        path: "f.ts",
        changeType: "typechange",
        insertions: null,
        deletions: null,
      },
      {
        path: "g.bin",
        changeType: "modified",
        insertions: null,
        deletions: null,
      },
    ];
    expect(computeAggregateStats(changes)).toEqual({
      insertions: 0,
      deletions: 0,
    });
  });
});
