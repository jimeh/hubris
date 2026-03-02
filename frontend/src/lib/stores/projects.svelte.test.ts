// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '$lib/types';
import type { EventHandler } from '$lib/events';

// --- Mocks ---

const mockAddProject = vi.fn();
const mockDeleteProject = vi.fn();
const mockReorderProjects = vi.fn();

vi.mock('$lib/api', () => ({
  addProject: (...args: unknown[]) => mockAddProject(...args),
  deleteProject: (...args: unknown[]) => mockDeleteProject(...args),
  reorderProjects: (...args: unknown[]) => mockReorderProjects(...args),
}));

/** Controllable event emitter standing in for EventClient. */
class MockEventClient {
  private handlers = new Map<string, Set<EventHandler>>();

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.handlers.get(event)?.delete(handler as EventHandler);
  }

  /** Emit an event to registered handlers. */
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

// --- Helpers ---

function makeProject(overrides: Partial<Project> & { id: string }): Project {
  return {
    name: overrides.name ?? `Project ${overrides.id}`,
    path: overrides.path ?? `/path/${overrides.id}`,
    position: overrides.position ?? 1,
    ...overrides,
  };
}

/** Fresh import to reset module-level singleton state. */
async function getStore() {
  const mod = await import('./projects.svelte');
  return mod.getProjectStore();
}

// --- Tests ---

describe('Project store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockEvents = new MockEventClient();
    localStorage.clear();

    // Reset module so `initialized` flag is cleared
    vi.resetModules();
  });

  // -- SSE handlers --

  describe('SSE snapshot', () => {
    it('sets projects sorted by position', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 2 });
      const p2 = makeProject({ id: 'b', position: 1 });

      mockEvents.emit('snapshot', { projects: [p1, p2] });

      expect(store.projects.map((p) => p.id)).toEqual(['b', 'a']);
    });

    it('restores selected from localStorage', async () => {
      localStorage.setItem('hubris-selected-project', 'b');
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      const p2 = makeProject({ id: 'b', position: 2 });

      mockEvents.emit('snapshot', { projects: [p1, p2] });

      expect(store.selected?.id).toBe('b');
    });

    it('nulls selected if project no longer exists', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      const p2 = makeProject({ id: 'b', position: 2 });

      mockEvents.emit('snapshot', { projects: [p1, p2] });
      store.select(p1);
      expect(store.selected?.id).toBe('a');

      // Snapshot without project 'a'
      mockEvents.emit('snapshot', { projects: [p2] });
      expect(store.selected).toBeNull();
    });
  });

  describe('SSE project_added', () => {
    it('appends new project', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      mockEvents.emit('snapshot', { projects: [p1] });

      const p2 = makeProject({ id: 'b', position: 2 });
      mockEvents.emit('project_added', p2);

      expect(store.projects).toHaveLength(2);
      expect(store.projects[1].id).toBe('b');
    });

    it('deduplicates existing project', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      mockEvents.emit('snapshot', { projects: [p1] });

      mockEvents.emit('project_added', p1);

      expect(store.projects).toHaveLength(1);
    });
  });

  describe('SSE project_removed', () => {
    it('filters out removed project', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      const p2 = makeProject({ id: 'b', position: 2 });
      mockEvents.emit('snapshot', { projects: [p1, p2] });

      mockEvents.emit('project_removed', { project_id: 'a' });

      expect(store.projects).toHaveLength(1);
      expect(store.projects[0].id).toBe('b');
    });

    it('nulls selected if removed project was selected', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      mockEvents.emit('snapshot', { projects: [p1] });
      store.select(p1);

      mockEvents.emit('project_removed', { project_id: 'a' });

      expect(store.selected).toBeNull();
    });
  });

  describe('SSE project_updated', () => {
    it('updates project in list', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1, name: 'Old' });
      mockEvents.emit('snapshot', { projects: [p1] });

      const updated = makeProject({ id: 'a', position: 1, name: 'New' });
      mockEvents.emit('project_updated', updated);

      expect(store.projects[0].name).toBe('New');
    });

    it('refreshes selected reference', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1, name: 'Old' });
      mockEvents.emit('snapshot', { projects: [p1] });
      store.select(p1);

      const updated = makeProject({ id: 'a', position: 1, name: 'New' });
      mockEvents.emit('project_updated', updated);

      expect(store.selected?.name).toBe('New');
    });
  });

  describe('SSE projects_reordered', () => {
    it('replaces full project list', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      const p2 = makeProject({ id: 'b', position: 2 });
      mockEvents.emit('snapshot', { projects: [p1, p2] });

      const reordered = [
        makeProject({ id: 'b', position: 1 }),
        makeProject({ id: 'a', position: 2 }),
      ];
      mockEvents.emit('projects_reordered', reordered);

      expect(store.projects.map((p) => p.id)).toEqual(['b', 'a']);
    });
  });

  // -- Store actions --

  describe('add()', () => {
    it('calls API and optimistically inserts', async () => {
      const newProject = makeProject({ id: 'new', position: 1 });
      mockAddProject.mockResolvedValue(newProject);
      const store = await getStore();

      const result = await store.add('/path/new');

      expect(mockAddProject).toHaveBeenCalledWith('/path/new');
      expect(result).toEqual(newProject);
      expect(store.projects).toHaveLength(1);
      expect(store.projects[0].id).toBe('new');
    });

    it('deduplicates if project already exists', async () => {
      const project = makeProject({ id: 'a', position: 1 });
      mockAddProject.mockResolvedValue(project);
      const store = await getStore();
      mockEvents.emit('snapshot', { projects: [project] });

      await store.add('/path/a');

      expect(store.projects).toHaveLength(1);
    });
  });

  describe('remove()', () => {
    it('optimistically removes and calls API', async () => {
      mockDeleteProject.mockResolvedValue(undefined);
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      const p2 = makeProject({ id: 'b', position: 2 });
      mockEvents.emit('snapshot', { projects: [p1, p2] });

      await store.remove('a');

      expect(mockDeleteProject).toHaveBeenCalledWith('a');
      expect(store.projects).toHaveLength(1);
      expect(store.projects[0].id).toBe('b');
    });

    it('clears selected and localStorage when removing selected', async () => {
      mockDeleteProject.mockResolvedValue(undefined);
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      mockEvents.emit('snapshot', { projects: [p1] });
      store.select(p1);
      expect(localStorage.getItem('hubris-selected-project')).toBe('a');

      await store.remove('a');

      expect(store.selected).toBeNull();
      expect(localStorage.getItem('hubris-selected-project')).toBeNull();
    });

    it('logs but does not throw on API errors', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockDeleteProject.mockRejectedValue(new Error('500'));
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      mockEvents.emit('snapshot', { projects: [p1] });

      // Should not throw (fire-and-forget safe)
      await store.remove('a');

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to delete project:',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('reorder()', () => {
    it('optimistically resequences with clean integers', async () => {
      mockReorderProjects.mockResolvedValue(undefined);
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      const p2 = makeProject({ id: 'b', position: 2 });
      const p3 = makeProject({ id: 'c', position: 3 });
      mockEvents.emit('snapshot', { projects: [p1, p2, p3] });

      await store.reorder(['c', 'a', 'b']);

      expect(mockReorderProjects).toHaveBeenCalledWith(['c', 'a', 'b']);
      expect(store.projects.map((p) => p.id)).toEqual(['c', 'a', 'b']);
      expect(store.projects.map((p) => p.position)).toEqual([1, 2, 3]);
    });
  });

  describe('select()', () => {
    it('sets selected and persists to localStorage', async () => {
      const store = await getStore();
      const p1 = makeProject({ id: 'a', position: 1 });
      mockEvents.emit('snapshot', { projects: [p1] });

      store.select(p1);

      expect(store.selected?.id).toBe('a');
      expect(localStorage.getItem('hubris-selected-project')).toBe('a');
    });
  });
});
