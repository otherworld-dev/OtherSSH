import { describe, it, expect } from 'vitest';
import {
  checkDue,
  compareVersions,
  FEED_URL,
  feedUrl,
  idleInstall,
  IDLE_SECS,
  LOCK_SECS,
  LockState,
  manualInstall,
  NUDGE_AFTER_SECS,
  nudgeDue,
  outcome,
  parseChannel,
  parseMode,
  pendingSince,
  quitInstall,
  RETRY_SECS,
  type InstallFacts,
} from './rules';

const away: InstallFacts = {
  mode: 'auto',
  pending: true,
  systemIdleSecs: IDLE_SECS,
  liveSessions: 0,
  transfers: 0,
  modalOpen: false,
  lastAttemptSecsAgo: undefined,
  sessionEnding: false,
  sessionLockedFor: undefined,
  sinceWakeSecs: undefined,
};

describe('settings parsing', () => {
  it('defaults to installing automatically on the stable channel', () => {
    expect(parseMode(undefined)).toBe('auto');
    expect(parseMode('ask')).toBe('ask');
    expect(parseMode('off')).toBe('off');
    expect(parseChannel('beta')).toBe('beta');
    expect(parseChannel('nightly')).toBe('stable');
  });
});

describe('feedUrl', () => {
  it('fills in the target, arch and version, adding the channel only for beta', () => {
    expect(feedUrl(FEED_URL, 'win32', 'x64', '0.1.0', 'stable')).toBe('https://api.otherworld.dev/v1/updates/otherssh/windows/x86_64/0.1.0');
    expect(feedUrl(FEED_URL, 'win32', 'arm64', '0.2.0-beta.1', 'beta')).toBe(
      'https://api.otherworld.dev/v1/updates/otherssh/windows/aarch64/0.2.0-beta.1?channel=beta',
    );
  });
});

describe('compareVersions', () => {
  it('orders by number, then a release above its pre-releases', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1);
  });
});

describe('idleInstall', () => {
  it('installs when the user has been away long enough with nothing open', () => {
    expect(idleInstall(away)).toBeNull();
  });

  it('waits for automatic mode, a pending update and a day since the last try', () => {
    expect(idleInstall({ ...away, mode: 'ask' })).toBe('notAutomatic');
    expect(idleInstall({ ...away, pending: false })).toBe('nothingPending');
    expect(idleInstall({ ...away, lastAttemptSecsAgo: 60 })).toBe('triedRecently');
    expect(idleInstall({ ...away, lastAttemptSecsAgo: RETRY_SECS })).toBeNull();
    expect(idleInstall({ ...away, lastAttemptSecsAgo: -60 })).toBeNull(); // clock went back
  });

  it('never drops live connections, a running upload or an open dialog', () => {
    expect(idleInstall({ ...away, liveSessions: 1 })).toBe('liveSessions');
    expect(idleInstall({ ...away, transfers: 1 })).toBe('transfers');
    expect(idleInstall({ ...away, modalOpen: true })).toBe('modalOpen');
    expect(idleInstall({ ...away, sessionEnding: true })).toBe('sessionEnding');
  });

  it('needs twenty minutes without input, or two minutes locked', () => {
    expect(idleInstall({ ...away, systemIdleSecs: IDLE_SECS - 1 })).toBe('recentInput');
    expect(idleInstall({ ...away, systemIdleSecs: 0, sessionLockedFor: LOCK_SECS })).toBeNull();
    expect(idleInstall({ ...away, systemIdleSecs: 0, sessionLockedFor: LOCK_SECS - 1 })).toBe('recentlyLocked');
  });

  it('waits the full time after an unlock or a wake from sleep', () => {
    expect(idleInstall({ ...away, sinceWakeSecs: IDLE_SECS - 1 })).toBe('justWoke');
    expect(idleInstall({ ...away, sessionLockedFor: LOCK_SECS, sinceWakeSecs: LOCK_SECS - 1 })).toBe('justWoke');
  });
});

describe('manual and quit installs', () => {
  it('lets the user restart now whatever the mode, but not mid-upload', () => {
    expect(manualInstall({ ...away, mode: 'off', systemIdleSecs: 0, liveSessions: 2, lastAttemptSecsAgo: 1 })).toBeNull();
    expect(manualInstall({ ...away, transfers: 1 })).toBe('transfers');
    expect(manualInstall({ ...away, pending: false })).toBe('nothingPending');
  });

  it('installs on quit only in automatic mode, once a day', () => {
    expect(quitInstall({ ...away, systemIdleSecs: 0, liveSessions: 3 })).toBeNull();
    expect(quitInstall({ ...away, mode: 'ask' })).toBe('notAutomatic');
    expect(quitInstall({ ...away, lastAttemptSecsAgo: 10 })).toBe('triedRecently');
    expect(quitInstall({ ...away, sessionEnding: true })).toBe('sessionEnding');
  });
});

describe('LockState', () => {
  it('times a lock from the first lock event and forgets it on unlock', () => {
    const s = new LockState();
    expect(s.apply('lock', 100)).toBe(true);
    expect(s.apply('lock', 150)).toBe(false);
    expect(s.lockedFor(220)).toBe(120);
    s.apply('unlock', 300);
    expect(s.lockedFor(400)).toBeUndefined();
    expect(s.sinceWake(400)).toBe(100);
  });

  it('makes waiting timers stale across a sleep and restarts the wait on a locked resume', () => {
    const s = new LockState();
    s.apply('lock', 0);
    const before = s.generation;
    expect(s.apply('suspend', 10)).toBe(false);
    expect(s.generation).not.toBe(before);
    expect(s.apply('resume', 5000)).toBe(true);
    expect(s.sinceWake(5010)).toBe(10);
  });
});

describe('check and nudge timing', () => {
  it('checks after a wake only when the last check is over four hours old', () => {
    expect(checkDue('auto', false, undefined)).toBe(true);
    expect(checkDue('auto', false, 60)).toBe(false);
    expect(checkDue('auto', false, 5 * 60 * 60)).toBe(true);
    expect(checkDue('off', false, undefined)).toBe(false);
    expect(checkDue('auto', true, undefined)).toBe(false);
  });

  it('keeps the pending clock per running version', () => {
    const stored = { from: '0.1.0', since: 100 };
    expect(pendingSince(stored, '0.1.0', 500)).toBe(stored);
    expect(pendingSince(stored, '0.2.0', 500)).toEqual({ from: '0.2.0', since: 500 });
    expect(pendingSince({ from: '0.1.0', since: 900 }, '0.1.0', 500)).toEqual({ from: '0.1.0', since: 500 });
  });

  it('nudges once an update has waited three days, then every three days at most', () => {
    expect(nudgeDue('auto', NUDGE_AFTER_SECS, undefined)).toBe(true);
    expect(nudgeDue('auto', NUDGE_AFTER_SECS - 1, undefined)).toBe(false);
    expect(nudgeDue('auto', NUDGE_AFTER_SECS, 60)).toBe(false);
    expect(nudgeDue('ask', NUDGE_AFTER_SECS, undefined)).toBe(false);
  });
});

describe('outcome', () => {
  const attempt = { version: '0.2.0', from: '0.1.0', notes: 'Uploads', at: 1 };
  it('says whether the last install worked', () => {
    expect(outcome(attempt, '0.2.0')).toEqual({ kind: 'updated', version: '0.2.0', notes: 'Uploads' });
    expect(outcome(attempt, '0.1.0')).toEqual({ kind: 'failed' });
    expect(outcome(attempt, '0.3.0')).toEqual({ kind: 'nothing' });
    expect(outcome(undefined, '0.1.0')).toEqual({ kind: 'nothing' });
  });
});
