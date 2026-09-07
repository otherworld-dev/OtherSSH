import { JsonStore } from './json-store';
import type { Settings } from '../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", Menlo, monospace',
  fontSize: 14,
  scrollback: 5000,
};

type Listener = (settings: Settings) => void;

export class SettingsStore {
  private readonly store: JsonStore<Partial<Settings>>;
  private value: Settings = { ...DEFAULT_SETTINGS };
  private readonly listeners = new Set<Listener>();

  constructor(file: string) {
    this.store = new JsonStore<Partial<Settings>>(file);
  }

  async load(): Promise<void> {
    const raw = await this.store.load({});
    this.value = normalise({ ...DEFAULT_SETTINGS, ...raw });
  }

  get(): Settings {
    return { ...this.value };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.value = normalise({ ...this.value, ...patch });
    await this.store.set(this.value);
    const snapshot = this.get();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function normalise(settings: Settings): Settings {
  const out: Settings = { ...settings };
  if (!out.sshPath?.trim()) delete out.sshPath;
  return out;
}
