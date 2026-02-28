import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock location for terminalWsUrl
vi.stubGlobal('location', {
  protocol: 'http:',
  host: 'localhost:5173',
});

// Import after mocking globals
const {
  listProjects,
  addProject,
  deleteProject,
  terminalWsUrl,
  listFiles,
  listTabs,
  createTab,
  deleteTab,
  updateTab,
} = await import('./api');

describe('API client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('listProjects', () => {
    it('fetches from /api/projects and returns JSON', async () => {
      const mockProjects = [{ id: '1', name: 'test', path: '/test' }];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockProjects),
        }),
      );

      const result = await listProjects();
      expect(fetch).toHaveBeenCalledWith('/api/projects');
      expect(result).toEqual(mockProjects);
    });

    it('throws on non-OK response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        }),
      );

      await expect(listProjects()).rejects.toThrow('500');
    });
  });

  describe('addProject', () => {
    it('sends POST with path in body', async () => {
      const mockProject = {
        id: '2',
        name: 'myrepo',
        path: '/home/user/myrepo',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockProject),
        }),
      );

      const result = await addProject('/home/user/myrepo');
      expect(fetch).toHaveBeenCalledWith('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/home/user/myrepo' }),
      });
      expect(result).toEqual(mockProject);
    });
  });

  describe('deleteProject', () => {
    it('sends DELETE to /api/projects/:id', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      await deleteProject('abc-123');
      expect(fetch).toHaveBeenCalledWith('/api/projects/abc-123', {
        method: 'DELETE',
      });
    });
  });

  describe('listFiles', () => {
    it('fetches from /api/files with default params', async () => {
      const mockResponse = {
        path: '/home/user',
        entries: [{ name: 'projects', is_git_repo: false }],
        home_dir: '/home/user',
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockResponse),
        }),
      );

      const result = await listFiles();
      expect(fetch).toHaveBeenCalledWith('/api/files?');
      expect(result).toEqual(mockResponse);
    });

    it('passes path and show_hidden params', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () =>
            Promise.resolve({
              path: '/tmp',
              entries: [],
              home_dir: '/home/user',
            }),
        }),
      );

      await listFiles('/tmp', true);
      expect(fetch).toHaveBeenCalledWith(
        '/api/files?path=%2Ftmp&show_hidden=true',
      );
    });

    it('throws readable error for 404', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        }),
      );

      await expect(listFiles('/nope')).rejects.toThrow('Directory not found');
    });

    it('throws readable error for 403', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
        }),
      );

      await expect(listFiles('/secret')).rejects.toThrow('Permission denied');
    });
  });

  describe('terminalWsUrl', () => {
    it('constructs ws:// URL with tab_id param', () => {
      const url = terminalWsUrl('tab-1');
      expect(url).toBe('ws://localhost:5173/api/terminal/ws?tab_id=tab-1');
    });

    it('constructs wss:// URL for https: protocol', () => {
      vi.stubGlobal('location', {
        protocol: 'https:',
        host: 'example.com',
      });

      const url = terminalWsUrl('tab-2');
      expect(url).toBe('wss://example.com/api/terminal/ws?tab_id=tab-2');
    });
  });

  describe('listTabs', () => {
    it('fetches from /api/tabs', async () => {
      const mockTabs = [
        {
          id: 't1',
          session_id: 'default',
          project_id: 'p1',
          label: 'Terminal 1',
          type: 'terminal',
          position: 1.0,
          created_at: 1000,
        },
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTabs),
        }),
      );

      const result = await listTabs();
      expect(fetch).toHaveBeenCalledWith('/api/tabs');
      expect(result).toEqual(mockTabs);
    });
  });

  describe('createTab', () => {
    it('sends POST with project_id in body', async () => {
      const mockTab = {
        id: 't1',
        session_id: 'default',
        project_id: 'p1',
        label: 'Terminal 1',
        type: 'terminal',
        position: 1.0,
        created_at: 1000,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTab),
        }),
      );

      const result = await createTab('p1');
      expect(fetch).toHaveBeenCalledWith('/api/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: 'p1' }),
      });
      expect(result).toEqual(mockTab);
    });
  });

  describe('deleteTab', () => {
    it('sends DELETE to /api/tabs/:id', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
        }),
      );

      await deleteTab('t1');
      expect(fetch).toHaveBeenCalledWith('/api/tabs/t1', {
        method: 'DELETE',
      });
    });

    it('tolerates 404 (already gone)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        }),
      );

      // Should not throw
      await deleteTab('t1');
    });
  });

  describe('updateTab', () => {
    it('sends PATCH with body', async () => {
      const mockTab = {
        id: 't1',
        session_id: 'default',
        project_id: 'p1',
        label: 'My Shell',
        type: 'terminal',
        position: 1.0,
        created_at: 1000,
      };
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve(mockTab),
        }),
      );

      const result = await updateTab('t1', {
        label: 'My Shell',
      });
      expect(fetch).toHaveBeenCalledWith('/api/tabs/t1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'My Shell' }),
      });
      expect(result).toEqual(mockTab);
    });
  });
});
