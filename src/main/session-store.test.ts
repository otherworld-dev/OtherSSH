import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './session-store';
import type { SessionProfile } from '../shared/types';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sshit-sessions-'));
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
