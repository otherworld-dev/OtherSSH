import { describe, it, expect } from 'vitest';
import { resolveSshPath } from './ssh-path';

const SYSTEM32_SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe';
const GIT_SSH = 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe';

function win(existing: string[], settingsPath?: string) {
  return resolveSshPath({
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    exists: (p) => existing.includes(p),
    settingsPath,
  });
}

function posix(existing: string[], settingsPath?: string) {
  return resolveSshPath({
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    exists: (p) => existing.includes(p),
    settingsPath,
  });
}

describe('resolveSshPath', () => {
  it('uses the configured path when it exists', () => {
    expect(win([SYSTEM32_SSH, 'D:\\tools\\ssh.exe'], 'D:\\tools\\ssh.exe')).toBe('D:\\tools\\ssh.exe');
  });

  it('ignores a configured path that does not exist and falls through', () => {
    expect(win([SYSTEM32_SSH], 'D:\\missing\\ssh.exe')).toBe(SYSTEM32_SSH);
  });

  it('prefers the Windows System32 OpenSSH build over anything on PATH', () => {
    expect(win([GIT_SSH, SYSTEM32_SSH])).toBe(SYSTEM32_SSH);
  });

  it('falls back to scanning PATH with PATHEXT on Windows', () => {
    expect(win([GIT_SSH])).toBe(GIT_SSH);
  });

  it('prefers /usr/bin/ssh on posix', () => {
    expect(posix(['/usr/local/bin/ssh', '/usr/bin/ssh'])).toBe('/usr/bin/ssh');
  });

  it('falls back to scanning PATH on posix', () => {
    expect(posix(['/usr/local/bin/ssh'])).toBe('/usr/local/bin/ssh');
  });

  it('returns null when no ssh binary can be found', () => {
    expect(win([])).toBeNull();
    expect(posix([])).toBeNull();
  });
});
