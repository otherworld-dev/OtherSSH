import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store';
import type { SessionProfile } from '../shared/types';

interface SessionsFile {
  version: 1;
  profiles: SessionProfile[];
}

type Listener = (profiles: SessionProfile[]) => void;

/** Saved connection profiles. Never holds secrets: keys are referenced by path only. */
export class SessionStore {
  private readonly store: JsonStore<SessionsFile>;
  private profiles: SessionProfile[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(file: string) {
    this.store = new JsonStore<SessionsFile>(file);
  }

  async load(): Promise<void> {
    const data = await this.store.load({ version: 1, profiles: [] });
    this.profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  }

  list(): SessionProfile[] {
    return this.profiles.map((p) => ({ ...p }));
  }

  get(id: string): SessionProfile | undefined {
    const found = this.profiles.find((p) => p.id === id);
    return found ? { ...found } : undefined;
  }

  async save(profile: SessionProfile): Promise<SessionProfile> {
    const saved: SessionProfile = { ...profile, id: profile.id || randomUUID() };
    const index = this.profiles.findIndex((p) => p.id === saved.id);
    if (index >= 0) this.profiles[index] = saved;
    else this.profiles.push(saved);
    await this.persist();
    return { ...saved };
  }

  async delete(id: string): Promise<void> {
    this.profiles = this.profiles.filter((p) => p.id !== id);
    await this.persist();
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async persist(): Promise<void> {
    await this.store.set({ version: 1, profiles: this.profiles });
    const snapshot = this.list();
    for (const listener of this.listeners) listener(snapshot);
  }
}
