import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from './json-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'otherssh-json-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('JsonStore', () => {
  it('returns the fallback when the file does not exist', async () => {
    const store = new JsonStore<{ n: number }>(join(dir, 'a.json'));
    expect(await store.load({ n: 1 })).toEqual({ n: 1 });
  });

  it('round-trips a value through disk', async () => {
    const file = join(dir, 'a.json');
    await new JsonStore<{ n: number }>(file).set({ n: 42 });
    expect(await new JsonStore<{ n: number }>(file).load({ n: 0 })).toEqual({ n: 42 });
  });

  it('leaves no temp file behind after writing', async () => {
    await new JsonStore<number[]>(join(dir, 'a.json')).set([1, 2, 3]);
    expect(await readdir(dir)).toEqual(['a.json']);
  });

  it('renames a corrupt file to .bad and returns the fallback', async () => {
    const file = join(dir, 'a.json');
    await writeFile(file, '{ not json', 'utf8');
    expect(await new JsonStore<string>(file).load('fallback')).toBe('fallback');
    expect((await readdir(dir)).sort()).toEqual(['a.json.bad']);
  });

  it('serialises concurrent writes so the last one wins and the file stays valid', async () => {
    const file = join(dir, 'a.json');
    const store = new JsonStore<number>(file);
    await Promise.all([store.set(1), store.set(2), store.set(3)]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toBe(3);
  });
});
