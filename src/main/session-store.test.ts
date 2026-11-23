import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session-store';
import type { SessionProfile } from '../shared/types';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otherssh-sessions-'));
  file = join(dir, 'sessions.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fresh(): Promise<SessionStore> {
  const store = new SessionStore(file);
  await store.load();
  return store;
}

describe('SessionStore', () => {
  it('starts empty when there is no file', async () => {
    expect((await fresh()).list()).toEqual([]);
  });

  it('assigns an id to a new profile and persists it', async () => {
    const store = await fresh();
    const saved = await store.save({ id: '', name: 'Webserver', host: 'webserver' });
    expect(saved.id).not.toBe('');
    expect((await fresh()).list()).toEqual([saved]);
  });

  it('replaces an existing profile with the same id', async () => {
    const store = await fresh();
    const saved = await store.save({ id: '', name: 'Old', host: 'h' });
    await store.save({ ...saved, name: 'New' });
    expect((await fresh()).list()).toEqual([{ ...saved, name: 'New' }]);
  });

  it('deletes a profile by id', async () => {
    const store = await fresh();
    const a = await store.save({ id: '', name: 'A', host: 'a' });
    const b = await store.save({ id: '', name: 'B', host: 'b' });
    await store.delete(a.id);
    expect((await fresh()).list()).toEqual([b]);
  });

  it('looks up a profile by id', async () => {
    const store = await fresh();
    const a = await store.save({ id: '', name: 'A', host: 'a' });
    expect(store.get(a.id)).toEqual(a);
    expect(store.get('nope')).toBeUndefined();
  });

  it('notifies listeners with the full list after every change', async () => {
    const store = await fresh();
    const seen: SessionProfile[][] = [];
    store.onChange((list) => seen.push(list));
    const a = await store.save({ id: '', name: 'A', host: 'a' });
    await store.delete(a.id);
    expect(seen).toEqual([[a], []]);
  });
});

describe('SessionStore migration', () => {
  it('turns the 0.3.0 allowClaude flag into allowAi', async () => {
    const profiles = [
      { id: 'a', name: 'web01', host: 'web01', allowClaude: true },
      { id: 'b', name: 'db01', host: 'db01', allowClaude: false },
      { id: 'c', name: 'app01', host: 'app01', allowAi: true },
    ];
    await writeFile(file, JSON.stringify({ version: 1, profiles }), 'utf8');
    const store = await fresh();
    expect(store.list()).toEqual([
      { id: 'a', name: 'web01', host: 'web01', allowAi: true },
      { id: 'b', name: 'db01', host: 'db01' },
      { id: 'c', name: 'app01', host: 'app01', allowAi: true },
    ]);
  });
});
