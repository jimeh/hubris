// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandler } from '$lib/events';
import type { Worktree } from '$lib/types';

const mockCreateProjectWorktree = vi.fn();
const mockDeleteProjectWorktree = vi.fn();
const mockReorderProjectWorktrees = vi.fn();

vi.mock('$lib/api', () => ({
  createProjectWorktree: (...args: unknown[]) =>
    mockCreateProjectWorktree(...args),
  deleteProjectWorktree: (...args: unknown[]) =>
    mockDeleteProjectWorktree(...args),
  reorderProjectWorktrees: (...args: unknown[]) =>
    mockReorderProjectWorktrees(...args),
}));

class MockEventClient {
  private handlers = new Map<string, Set<EventHandler>>();

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.handlers.get(event)?.delete(handler as EventHandler);
  }

  emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(data);
    }
  }
}

let mockEvents: MockEventClient;

vi.mock('$lib/events', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/events')>('$lib/events');
  return {
    ...actual,
    getEventClient: () => {
      if (!mockEvents) mockEvents = new MockEventClient();
      return mockEvents;
    },
  };
});

function makeWorktree(
  overrides: Partial<Worktree> & { id: string; project_id: string },
): Worktree {
  return {
    id: overrides.id,
    project_id: overrides.project_id,
    name: overrides.name ?? 'worktree',
    path: overrides.path ?? '/tmp/worktree',
    branch: overrides.branch ?? 'main',
    is_local: overrides.is_local ?? false,
    missing_on_disk: overrides.missing_on_disk ?? false,
    position: overrides.position ?? 1,
  };
}

async function getStore() {
  const mod = await import('./worktrees.svelte');
  return mod.getWorktreeStore();
}

describe('Worktree store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
    mockEvents = new MockEventClient();
  });

  it('preserves missing_on_disk from snapshot payload', async () => {
    const store = await getStore();
    const local = makeWorktree({
      id: 'local',
      project_id: 'p1',
      name: 'local',
      is_local: true,
      branch: 'local',
      position: 1,
    });
    const missing = makeWorktree({
      id: 'missing',
      project_id: 'p1',
      name: 'feature-a',
      missing_on_disk: true,
      position: 2,
    });

    mockEvents.emit('snapshot', {
      worktrees: {
        p1: [local, missing],
      },
      project_errors: {},
    });

    const list = store.worktreesForProject('p1');
    const missingWorktree = list.find((wt) => wt.id === 'missing');
    expect(missingWorktree?.missing_on_disk).toBe(true);
  });
});
