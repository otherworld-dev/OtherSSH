import type { UpdateChannel, UpdateMode } from '../../shared/types';

// The decisions behind automatic updates, kept pure so each rule has a test.
// Ported from OtherLook (src-tauri/src/updates.rs) with one change that matters
// for a terminal: an install while the user is away restarts the app, which
// would drop live ssh connections, so it only happens when none are open.

export const FEED_URL = 'https://api.otherworld.dev/v1/updates/otherssh/{{target}}/{{arch}}/{{current_version}}';
export const INSTALL_ID_HEADER = 'X-Install-Id';

/** Away for this long (no input anywhere in the session) counts as idle. */
export const IDLE_SECS = 20 * 60;
/** Locked for this long counts as away. */
export const LOCK_SECS = 2 * 60;
/** After an install is started, automatic ones wait this long before trying again. */
export const RETRY_SECS = 24 * 60 * 60;
/** How often the idle watch looks. */
export const IDLE_CHECK_EVERY_SECS = 5 * 60;
export const CHECK_EVERY_SECS = 4 * 60 * 60;
/** An update left waiting this long gets one gentle "restart now" toast, and no more often than this. */
export const NUDGE_AFTER_SECS = 3 * 24 * 60 * 60;

export function parseMode(value: unknown): UpdateMode {
  return value === 'ask' || value === 'off' ? value : 'auto';
}

export function parseChannel(value: unknown): UpdateChannel {
  return value === 'beta' ? 'beta' : 'stable';
}

const TARGETS: Record<string, string> = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const ARCHES: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i686' };

/** The check URL for this build, with the beta channel as a query. */
export function feedUrl(template: string, platform: string, arch: string, version: string, channel: UpdateChannel): string {
  const url = template
    .replace('{{target}}', TARGETS[platform] ?? platform)
    .replace('{{arch}}', ARCHES[arch] ?? arch)
    .replace('{{current_version}}', encodeURIComponent(version));
  if (channel !== 'beta') return url;
  return `${url}${url.includes('?') ? '&' : '?'}channel=beta`;
}

/** Compare dotted versions with an optional pre-release; a release beats its own pre-releases. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string] => {
    const [core = '', pre = ''] = v.trim().replace(/^v/, '').split('-', 2);
    return [core.split('.').map((n) => Number(n) || 0), pre];
  };
  const [ac, ap] = split(a);
  const [bc, bp] = split(b);
  for (let i = 0; i < Math.max(ac.length, bc.length); i++) {
    const d = (ac[i] ?? 0) - (bc[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (ap === bp) return 0;
  if (!ap) return 1;
  if (!bp) return -1;
  return ap < bp ? -1 : 1;
}

/** Everything an install decision looks at, gathered fresh each time. */
export interface InstallFacts {
  mode: UpdateMode;
  /** A downloaded, signature-checked update is waiting. */
  pending: boolean;
  /** Seconds since the last input anywhere in the Windows session. */
  systemIdleSecs: number;
  /** Open ssh connections across every window. */
  liveSessions: number;
  /** Uploads or "teach this server" runs in progress. */
  transfers: number;
  /** A dialog (session editor, settings, the upload folder question) is open. */
  modalOpen: boolean;
  lastAttemptSecsAgo: number | undefined;
  /** Windows is shutting down or logging off. */
  sessionEnding: boolean;
  /** Seconds the session has been locked; undefined while it isn't. */
  sessionLockedFor: number | undefined;
  /** Seconds since the session unlocked or the PC woke; undefined if neither has happened. */
  sinceWakeSecs: number | undefined;
}

export type Wait =
  | 'notAutomatic'
  | 'nothingPending'
  | 'triedRecently'
  | 'sessionEnding'
  | 'recentInput'
  | 'recentlyLocked'
  | 'justWoke'
  | 'liveSessions'
  | 'transfers'
  | 'modalOpen';

/** For the log. */
export const WAIT_REASONS: Record<Wait, string> = {
  notAutomatic: "updates aren't set to install automatically",
  nothingPending: 'no update is waiting',
  triedRecently: 'an install was tried in the last day',
  sessionEnding: 'Windows is shutting down',
  recentInput: 'the computer was used recently',
  recentlyLocked: 'the session was locked only a moment ago',
  justWoke: 'the computer was unlocked or woke from sleep only a moment ago',
  liveSessions: 'connections are open',
  transfers: 'an upload is running',
  modalOpen: 'a dialog is open',
};

/** A record from the future (the clock went back) doesn't block for ever. */
export function retryAllowed(lastAttemptSecsAgo: number | undefined): boolean {
  return lastAttemptSecsAgo === undefined || lastAttemptSecsAgo < 0 || lastAttemptSecsAgo >= RETRY_SECS;
}

/**
 * Install now, while the app is open and the user is away, then start it again.
 * Away is the session locked for LOCK_SECS (its idle time is ignored then: the
 * lock screen's own input resets it) or no input for IDLE_SECS, and either way
 * no unlock or wake for as long, so a timer that ran on through a sleep can't
 * fire just as the user comes back. Nothing may be open that a restart would lose.
 */
export function idleInstall(f: InstallFacts): Wait | null {
  if (f.mode !== 'auto') return 'notAutomatic';
  if (!f.pending) return 'nothingPending';
  if (!retryAllowed(f.lastAttemptSecsAgo)) return 'triedRecently';
  if (f.sessionEnding) return 'sessionEnding';
  let awayFor: number;
  if (f.sessionLockedFor !== undefined) {
    if (f.sessionLockedFor < LOCK_SECS) return 'recentlyLocked';
    awayFor = LOCK_SECS;
  } else {
    if (f.systemIdleSecs < IDLE_SECS) return 'recentInput';
    awayFor = IDLE_SECS;
  }
  if (f.sinceWakeSecs !== undefined && f.sinceWakeSecs < awayFor) return 'justWoke';
  if (f.liveSessions > 0) return 'liveSessions';
  if (f.transfers > 0) return 'transfers';
  if (f.modalOpen) return 'modalOpen';
  return null;
}

/** "Restart now": the user asked, so mode, idle and once-a-day rules don't apply (they confirm closing connections first). */
export function manualInstall(f: InstallFacts): Wait | null {
  if (!f.pending) return 'nothingPending';
  if (f.sessionEnding) return 'sessionEnding';
  if (f.transfers > 0) return 'transfers';
  return null;
}

/** Install as the app quits; it isn't started again. The user has already agreed to close any connections. */
export function quitInstall(f: InstallFacts): Wait | null {
  if (f.mode !== 'auto') return 'notAutomatic';
  if (!f.pending) return 'nothingPending';
  if (!retryAllowed(f.lastAttemptSecsAgo)) return 'triedRecently';
  if (f.sessionEnding) return 'sessionEnding';
  return null;
}

export type SessionEvent = 'lock' | 'unlock' | 'suspend' | 'resume';

/**
 * Whether the Windows session is locked, and when the user could last have come
 * back, on a monotonic clock in seconds. Every event moves `generation` on, so a
 * lock timer started before it can tell that it's stale.
 */
export class LockState {
  private lockedAt: number | undefined;
  private wokeAt: number | undefined;
  generation = 0;

  /** Returns true when a new lock timer should start. */
  apply(event: SessionEvent, now: number): boolean {
    switch (event) {
      case 'lock':
        if (this.lockedAt !== undefined) return false; // a repeated lock keeps the first one's time and timer
        this.lockedAt = now;
        break;
      case 'unlock':
        this.lockedAt = undefined;
        this.wokeAt = now;
        break;
      case 'suspend':
        break; // whatever is waiting is stale once it wakes
      case 'resume':
        this.wokeAt = now;
        break;
    }
    this.generation++;
    return this.lockedAt !== undefined && event !== 'suspend';
  }

  lockedFor(now: number): number | undefined {
    return this.lockedAt === undefined ? undefined : Math.max(0, now - this.lockedAt);
  }

  sinceWake(now: number): number | undefined {
    return this.wokeAt === undefined ? undefined : Math.max(0, now - this.wokeAt);
  }
}

/** Check now the user may be back (unlock, resume) if the last check was long enough ago. */
export function checkDue(mode: UpdateMode, pending: boolean, lastCheckSecsAgo: number | undefined): boolean {
  return mode !== 'off' && !pending && (lastCheckSecsAgo === undefined || lastCheckSecsAgo < 0 || lastCheckSecsAgo > CHECK_EVERY_SECS);
}

/** Since when the running version has had an update waiting. Kept per running version, so a newer release doesn't restart the wait. */
export interface PendingSince {
  from: string;
  since: number;
}

export function pendingSince(stored: PendingSince | undefined, running: string, now: number): PendingSince {
  return stored && stored.from === running && stored.since <= now ? stored : { from: running, since: now };
}

export function nudgeDue(mode: UpdateMode, pendingForSecs: number | undefined, nudgedSecsAgo: number | undefined): boolean {
  return (
    mode === 'auto' &&
    pendingForSecs !== undefined &&
    pendingForSecs >= NUDGE_AFTER_SECS &&
    (nudgedSecsAgo === undefined || nudgedSecsAgo < 0 || nudgedSecsAgo >= NUDGE_AFTER_SECS)
  );
}

/** An install the app started, remembered so the next start can say whether it worked. */
export interface Attempt {
  version: string;
  from: string;
  notes?: string;
  /** Unix seconds. */
  at: number;
  failureLogged?: boolean;
}

export type Outcome = { kind: 'updated'; version: string; notes?: string } | { kind: 'failed' } | { kind: 'nothing' };

export function outcome(attempt: Attempt | undefined, running: string): Outcome {
  if (attempt?.version === running) return { kind: 'updated', version: attempt.version, notes: attempt.notes };
  if (attempt?.from === running) return { kind: 'failed' };
  return { kind: 'nothing' };
}
