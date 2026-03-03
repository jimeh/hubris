import { describe, expect, it, vi } from 'vitest';

import { generateWorktreeBranchName } from './worktreeName';

describe('generateWorktreeBranchName', () => {
  it('returns a two-word kebab-case slug', () => {
    const name = generateWorktreeBranchName();
    expect(name).toMatch(/^[a-z0-9]+-[a-z0-9]+$/);
    expect(name).not.toContain(' ');
    expect(name).not.toContain('/');
  });

  it('avoids immediate duplicates when previous is provided', () => {
    const previous = 'able-aardvark';
    const alwaysZero = () => 0;
    const next = generateWorktreeBranchName(previous, alwaysZero);
    expect(next).not.toBe(previous);
  });

  it('is deterministic with injected RNG', () => {
    const rng = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5);

    const first = generateWorktreeBranchName(undefined, rng);
    const second = generateWorktreeBranchName(undefined, rng);

    expect(first).toBe('able-aardvark');
    expect(second).toBe('mad-leopon');
  });
});
