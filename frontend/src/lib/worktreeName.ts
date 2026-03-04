import { adjectives, animals } from 'unique-names-generator';

const FIRST_WORDS = adjectives as readonly string[];
const SECOND_WORDS = animals as readonly string[];

function pick(words: readonly string[], rng: () => number): string {
  const idx = Math.floor(rng() * words.length);
  return words[Math.max(0, Math.min(words.length - 1, idx))];
}

function toBranchSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateWorktreeBranchName(
  previous?: string,
  rng: () => number = Math.random,
): string {
  let candidate = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    candidate = toBranchSlug(
      `${pick(FIRST_WORDS, rng)}-${pick(SECOND_WORDS, rng)}`,
    );
    if (!candidate) {
      continue;
    }
    if (!previous || candidate !== previous) {
      return candidate;
    }
  }

  if (!previous || candidate !== previous) {
    return candidate;
  }

  const [prevFirst = '', prevSecond = ''] = previous.split('-', 2);
  const altFirst =
    FIRST_WORDS.find((word) => toBranchSlug(word) !== prevFirst) ??
    FIRST_WORDS[0];
  const altSecond =
    SECOND_WORDS.find((word) => toBranchSlug(word) !== prevSecond) ??
    SECOND_WORDS[0];
  return toBranchSlug(`${altFirst}-${altSecond}`) || 'worktree-branch';
}
