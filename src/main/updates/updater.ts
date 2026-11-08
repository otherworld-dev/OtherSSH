import { randomUUID } from 'node:crypto';
import type { JsonStore } from '../json-store';
import type { UpdateMode, UpdateNotice, UpdateStatus } from '../../shared/types';
import { parsePublicKey, signedFileName, verifySignature, type PublicKey } from './minisign';
import {
  checkDue,
  CHECK_EVERY_SECS,
  compareVersions,
  feedUrl,
  idleInstall,
  IDLE_CHECK_EVERY_SECS,
  INSTALL_ID_HEADER,
  LOCK_SECS,
  LockState,
  manualInstall,
  nudgeDue,
  outcome,
  pendingSince,
  quitInstall,
  WAIT_REASONS,
  type Attempt,
  type InstallFacts,
  type PendingSince,
  type SessionEvent,
  type Wait,
} from './rules';

// Checks the Otherworld Services feed soon after start and every four hours,
// downloads a newer release into memory, checks its minisign signature against
// the key built into the app, then installs it the way the update mode says:
// on quit, while the user is away with nothing open, or when they choose
// "Restart now". The installer is electron-builder's NSIS one run with /S, so
// a per-user install needs no UAC prompt; --force-run starts the app again.

/** What survives restarts, in updates.json next to settings.json. */
export interface UpdateState {
  installId?: string;
  /** Unix seconds. */
  lastCheckAt?: number;
  pendingSince?: PendingSince;
  nudgedAt?: number;
  attempt?: Attempt;
}

interface Manifest {
  version: string;
  notes?: string;
  url: string;
  signature: string;
}

interface Ready {
  version: string;
  notes?: string;
  name: string;
  bytes: Buffer;
  signature: string;
}

export interface UpdaterDeps {
  version: string;
  platform: string;
  arch: string;
  /** The installed Windows app; dev builds only check, against an override feed. */
  canInstall: boolean;
  /** The feed URL template; undefined turns checking off (a dev build without an override). */
  feed: string | undefined;
  /** Allow a plain-http feed and download (dev override only). */
  allowHttp: boolean;
  publicKey: string;
  store: JsonStore<UpdateState>;
  settings(): { updateMode: UpdateMode; updateChannel: 'stable' | 'beta' };
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response>;
  /** Live connections, running uploads and open dialogs, across every window. */
  activity(): { liveSessions: number; transfers: number; modalOpen: boolean };
  systemIdleSecs(): number;
  /** Write the installer somewhere it can run from and start it, detached. */
  launchInstaller(name: string, bytes: Buffer, relaunch: boolean): void;
  /** Close every window without the "connections will be terminated" question, and quit. */
  quitForInstall(): void;
  status(status: UpdateStatus): void;
  notify(notice: UpdateNotice): void;
  log(message: string): void;
}

const FIRST_CHECK_MS = 20_000;
const WAKE_CHECK_DELAY_MS = 30_000;
const NUDGE_POLL_MS = 30 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

/** What build.mjs names and signs the installer, version included. */
export const installerName = (version: string): string => `OtherSSH_${version}_x64-setup.exe`;

const nowSecs = (): number => Math.floor(Date.now() / 1000);
const monoSecs = (): number => performance.now() / 1000;

export class Updater {
  private state: UpdateState = {};
  private readonly key: PublicKey;
  private readonly lock = new LockState();
  private ready: Ready | null = null;
  private checking = false;
  private installing = false;
  private sessionEnding = false;
  private line = '';
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: UpdaterDeps) {
    this.key = parsePublicKey(deps.publicKey);
  }

  async start(): Promise<void> {
    this.state = await this.deps.store.load({});
    if (!this.state.installId) await this.save({ installId: randomUUID() });
    await this.reportLastAttempt();

    if (!this.deps.feed) {
      this.line = 'Updates are checked by the installed app.';
      this.publish();
      return;
    }
    this.timers.push(
      setTimeout(() => void this.check(false), FIRST_CHECK_MS),
      setInterval(() => void this.check(false), CHECK_EVERY_SECS * 1000),
      setInterval(() => void this.tryIdleInstall(), IDLE_CHECK_EVERY_SECS * 1000),
      setInterval(() => this.nudge(), NUDGE_POLL_MS),
    );
    this.publish();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  get status(): UpdateStatus {
    return {
      version: this.deps.version,
      checking: this.checking,
      ready: this.ready ? { version: this.ready.version, notes: this.ready.notes } : null,
      status: this.line,
      canInstall: this.deps.canInstall,
    };
  }

  /** Lock, unlock, sleep and wake, from Electron's powerMonitor. */
  sessionEvent(event: SessionEvent): void {
    const now = monoSecs();
    if (this.lock.apply(event, now)) {
      const generation = this.lock.generation;
      this.timers.push(
        setTimeout(() => {
          if (this.lock.generation === generation) void this.tryIdleInstall();
        }, LOCK_SECS * 1000 + 1000),
      );
    }
    if (event === 'unlock' || event === 'resume') {
      const ago = this.state.lastCheckAt === undefined ? undefined : nowSecs() - this.state.lastCheckAt;
      if (this.deps.feed && checkDue(this.mode, this.ready !== null, ago)) {
        this.timers.push(setTimeout(() => void this.check(false), WAKE_CHECK_DELAY_MS)); // let the network come back
      }
    }
  }

  /** Windows is shutting down or logging off: never start an installer into that. */
  sessionEnd(): void {
    this.sessionEnding = true;
  }

  /** The mode or channel changed in Settings. */
  settingsChanged(): void {
    if (this.ready) this.offer(false);
    else this.publish();
  }

  /** A manual check reports every outcome; the timed one stays quiet unless it finds something. */
  async check(manual: boolean): Promise<void> {
    if (!this.deps.feed) {
      if (manual) this.deps.notify({ kind: 'message', text: 'Updates are checked by the installed app, not a development build.', tone: 'info' });
      return;
    }
    if (this.checking || this.installing) return;
    if (!manual && this.mode === 'off') return;
    if (this.ready) {
      if (manual) this.offer(true);
      return;
    }
    this.checking = true;
    this.line = 'Checking for updates...';
    this.publish();
    try {
      const found = await this.fetchUpdate();
      await this.save({ lastCheckAt: nowSecs() });
      if (found) {
        this.ready = found;
        await this.save({ pendingSince: pendingSince(this.state.pendingSince, this.deps.version, nowSecs()) });
        this.deps.log(`updates: ${found.version} downloaded and verified`);
        this.offer(manual);
      } else {
        this.line = `You're up to date: OtherSSH ${this.deps.version} is the latest version.`;
        if (manual) this.deps.notify({ kind: 'message', text: this.line, tone: 'info' });
      }
    } catch (err) {
      this.line = `Couldn't check for updates: ${(err as Error).message}`;
      this.deps.log(`updates: ${this.line}`);
      if (manual) this.deps.notify({ kind: 'message', text: this.line, tone: 'error' });
    } finally {
      this.checking = false;
      this.publish();
    }
  }

  /** "Restart now". Throws with the reason when it can't go ahead. */
  async installNow(): Promise<void> {
    const wait = manualInstall(this.facts());
    if (wait === 'nothingPending') throw new Error("There's no downloaded update to install. Check for updates first.");
    if (wait === 'transfers') throw new Error('An upload is still running. Try again once it has finished.');
    if (wait) throw new Error(`The update can't install now: ${WAIT_REASONS[wait]}.`);
    if (!this.deps.canInstall) throw new Error('Only the installed app can install updates.');
    await this.install(true);
  }

  /**
   * The app is quitting. Returns a promise when an install should run first
   * (the caller holds the quit until it settles), or null to quit as normal.
   */
  onQuit(): Promise<void> | null {
    if (this.installing || !this.deps.canInstall) return null;
    const wait = quitInstall(this.facts());
    if (wait) {
      if (this.ready) this.deps.log(`updates: not installing on quit: ${WAIT_REASONS[wait]}`);
      return null;
    }
    return this.install(false).catch((err) => this.deps.log(`updates: install on quit failed: ${(err as Error).message}`));
  }

  private get mode(): UpdateMode {
    return this.deps.settings().updateMode;
  }

  private installsItself(): boolean {
    return this.mode === 'auto' && this.deps.canInstall;
  }

  private facts(): InstallFacts {
    const now = monoSecs();
    const activity = this.deps.activity();
    return {
      mode: this.mode,
      pending: this.ready !== null,
      systemIdleSecs: this.deps.systemIdleSecs(),
      ...activity,
      lastAttemptSecsAgo: this.state.attempt ? nowSecs() - this.state.attempt.at : undefined,
      sessionEnding: this.sessionEnding,
      sessionLockedFor: this.lock.lockedFor(now),
      sinceWakeSecs: this.lock.sinceWake(now),
    };
  }

  private async tryIdleInstall(): Promise<void> {
    if (this.installing || !this.deps.canInstall || !this.ready) return;
    const wait: Wait | null = idleInstall(this.facts());
    if (wait) return;
    this.deps.log('updates: installing while the user is away');
    await this.install(true).catch((err) => this.deps.log(`updates: idle install failed: ${(err as Error).message}`));
  }

  private async fetchUpdate(): Promise<Ready | null> {
    const { updateChannel } = this.deps.settings();
    const url = feedUrl(this.deps.feed!, this.deps.platform, this.deps.arch, this.deps.version, updateChannel);
    const res = await this.deps.fetch(url, { headers: { [INSTALL_ID_HEADER]: this.state.installId ?? '' } });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`the update server answered ${res.status}`);
    const manifest = (await res.json()) as Partial<Manifest>;
    if (typeof manifest.version !== 'string' || typeof manifest.url !== 'string' || typeof manifest.signature !== 'string') {
      throw new Error('the update server sent something unexpected');
    }
    if (compareVersions(manifest.version, this.deps.version) <= 0) return null;

    const download = new URL(manifest.url);
    if (download.protocol !== 'https:' && !(this.deps.allowHttp && download.protocol === 'http:')) {
      throw new Error('the update download is not over https');
    }
    const bytes = await this.download(download.href);
    const comment = verifySignature(bytes, manifest.signature, this.key);
    // The version is only in the unsigned manifest; the signed file name carries it too, so an
    // old signed installer can't be passed off as a newer release.
    const name = signedFileName(comment);
    if (name !== installerName(manifest.version)) throw new Error(`the signed installer is ${name ?? 'unnamed'}, not ${manifest.version}`);
    return { version: manifest.version, notes: manifest.notes || undefined, name, bytes, signature: manifest.signature };
  }

  /** The whole download in memory, stopping as soon as it passes the size cap. */
  private async download(url: string): Promise<Buffer> {
    const res = await this.deps.fetch(url);
    if (!res.ok) throw new Error(`the download answered ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES || !res.body) {
      await res.body?.cancel();
      if (!res.body) throw new Error('the download was empty');
      throw new Error('the download is too large');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error('the download is too large');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  private offer(manual: boolean): void {
    const ready = this.ready!;
    if (this.installsItself()) {
      this.line = `OtherSSH ${ready.version} will install when you close OtherSSH, or while you're away with no connections open.`;
      if (manual) this.deps.notify({ kind: 'message', text: this.line, tone: 'info' });
      this.nudge();
    } else {
      this.line = `OtherSSH ${ready.version} has been downloaded and is ready to install.`;
      if (this.deps.canInstall) this.deps.notify({ kind: 'ready', version: ready.version });
      else if (manual) this.deps.notify({ kind: 'message', text: this.line, tone: 'info' });
    }
    this.publish();
  }

  /** One gentle toast for an update that has waited days for a quiet moment; showing it starts the wait again. */
  private nudge(): void {
    if (!this.ready || !this.installsItself()) return;
    const now = nowSecs();
    const pendingFor = this.state.pendingSince ? now - this.state.pendingSince.since : undefined;
    const nudgedAgo = this.state.nudgedAt === undefined ? undefined : now - this.state.nudgedAt;
    if (!nudgeDue(this.mode, pendingFor, nudgedAgo)) return;
    void this.save({ nudgedAt: now });
    this.deps.notify({ kind: 'nudge', version: this.ready.version });
  }

  private async install(relaunch: boolean): Promise<void> {
    const ready = this.ready;
    if (!ready || this.installing) return;
    this.installing = true;
    try {
      verifySignature(ready.bytes, ready.signature, this.key); // held in memory since the check; check again before running it
      await this.save({ attempt: { version: ready.version, from: this.deps.version, notes: ready.notes, at: nowSecs() } });
      this.deps.log(`updates: starting the ${ready.version} installer${relaunch ? ', then restarting' : ''}`);
      this.deps.launchInstaller(ready.name, ready.bytes, relaunch);
    } catch (err) {
      this.installing = false;
      throw err;
    }
    if (relaunch) this.deps.quitForInstall();
  }

  /** On the first start after an install: say it worked, once, or log that it didn't. */
  private async reportLastAttempt(): Promise<void> {
    const attempt = this.state.attempt;
    const result = outcome(attempt, this.deps.version);
    if (result.kind === 'updated') {
      this.deps.notify({ kind: 'updated', version: result.version, notes: result.notes });
      await this.save({ attempt: undefined, pendingSince: undefined, nudgedAt: undefined });
    } else if (result.kind === 'failed' && attempt && !attempt.failureLogged) {
      this.deps.log(`updates: the install of ${attempt.version} didn't complete; still on ${this.deps.version}`);
      await this.save({ attempt: { ...attempt, failureLogged: true } });
    }
  }

  private async save(patch: Partial<UpdateState>): Promise<void> {
    this.state = { ...this.state, ...patch };
    await this.deps.store.set(this.state);
  }

  private publish(): void {
    this.deps.status(this.status);
  }
}
