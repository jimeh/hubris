import { getSettings, saveSettings } from '$lib/api';
import type { WorktreeSettings } from '$lib/theme/types';

const DEFAULTS: WorktreeSettings = {
  locationMode: 'dataDir',
};

let settings = $state<WorktreeSettings>({ ...DEFAULTS });

async function init() {
  try {
    const current = await getSettings();
    if (current.worktree) {
      settings = { ...DEFAULTS, ...current.worktree };
    }
  } catch {
    settings = { ...DEFAULTS };
  }
}

async function updateSettings(partial: Partial<WorktreeSettings>) {
  const previous = { ...settings };
  settings = { ...settings, ...partial };
  try {
    await saveSettings({
      worktree: $state.snapshot(settings),
    });
  } catch (err) {
    settings = previous;
    throw err;
  }
}

let store: ReturnType<typeof createStore> | null = null;

function createStore() {
  return {
    get settings() {
      return settings;
    },
    init,
    updateSettings,
  };
}

export function getWorktreeSettingsStore() {
  if (!store) {
    store = createStore();
  }
  return store;
}
