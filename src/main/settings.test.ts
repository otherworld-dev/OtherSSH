import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore, DEFAULT_SETTINGS } from './settings';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sshit-settings-'));
  file = join(dir, 'settings.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('returns the defaults when there is no file', async () => {
    const store = new SettingsStore(file);
    await store.load();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in missing keys from the defaults when the file is partial', async () => {
    await writeFile(file, JSON.stringify({ fontSize: 18 }), 'utf8');
    const store = new SettingsStore(file);
    await store.load();
    expect(store.get()).toEqual({ ...DEFAULT_SETTINGS, fontSize: 18 });
  });

  it('merges a patch and persists it', async () => {
    const store = new SettingsStore(file);
    await store.load();
    await store.update({ scrollback: 100, sshPath: 'D:\\ssh.exe' });
    const again = new SettingsStore(file);
    await again.load();
    expect(again.get()).toEqual({ ...DEFAULT_SETTINGS, scrollback: 100, sshPath: 'D:\\ssh.exe' });
  });

  it('drops sshPath when the patch sets it to an empty string', async () => {
    const store = new SettingsStore(file);
    await store.load();
    await store.update({ sshPath: 'D:\\ssh.exe' });
    await store.update({ sshPath: '' });
    expect(store.get().sshPath).toBeUndefined();
  });
});
