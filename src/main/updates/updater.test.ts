import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UpdateMode, UpdateNotice, UpdateStatus } from '../../shared/types';
import { IDLE_SECS } from './rules';
import { Updater, type UpdateState, type UpdaterDeps } from './updater';

const signerPath = '../../../scripts/release/minisign.mjs';
const INSTALLER = Buffer.from('pretend installer bytes');
const FEED = 'https://feed.test/v1/updates/otherssh/{{target}}/{{arch}}/{{current_version}}';
const DOWNLOAD = 'https://feed.test/downloads/otherssh/0.2.0/OtherSSH_0.2.0_x64-setup.exe';

let publicKey: string;
let goodSignature: string;
let badSignature: string;
let oldSignature: string;

beforeEach(async () => {
  const signer = await import(signerPath);
  const generated = signer.generateKey('pw');
  const key = signer.loadKey(generated.text, 'pw');
  publicKey = generated.publicKey;
  goodSignature = signer.signData(INSTALLER, key, 'timestamp:1\tfile:OtherSSH_0.2.0_x64-setup.exe');
  badSignature = signer.signData(Buffer.from('something else'), key, 'timestamp:1\tfile:x');
  oldSignature = signer.signData(INSTALLER, key, 'timestamp:1\tfile:OtherSSH_0.0.9_x64-setup.exe');
});

class MemoryStore {
  value: UpdateState;
  constructor(initial: UpdateState = {}) {
    this.value = initial;
  }
  async load(): Promise<UpdateState> {
    return this.value;
  }
  async set(v: UpdateState): Promise<void> {
    this.value = v;
  }
}

interface Harness {
  updater: Updater;
  store: MemoryStore;
  notices: UpdateNotice[];
  statuses: UpdateStatus[];
  launched: Array<{ name: string; relaunch: boolean }>;
  quits: number;
  requests: Array<{ url: string; headers?: Record<string, string> }>;
  activity: { liveSessions: number; transfers: number; modalOpen: boolean };
  idle: { secs: number };
  mode: { value: UpdateMode };
}

function harness(opts: { feed?: number; signature?: () => string; state?: UpdateState; version?: string } = {}): Harness {
  const h = {
    notices: [] as UpdateNotice[],
    statuses: [] as UpdateStatus[],
    launched: [] as Array<{ name: string; relaunch: boolean }>,
    quits: 0,
    requests: [] as Array<{ url: string; headers?: Record<string, string> }>,
    activity: { liveSessions: 0, transfers: 0, modalOpen: false },
    idle: { secs: 0 },
    mode: { value: 'auto' as UpdateMode },
    store: new MemoryStore(opts.state),
  };
  const deps: UpdaterDeps = {
    version: opts.version ?? '0.1.0',
    platform: 'win32',
    arch: 'x64',
    canInstall: true,
    feed: FEED,
    allowHttp: false,
    publicKey,
    store: h.store as never,
    settings: () => ({ updateMode: h.mode.value, updateChannel: 'stable' }),
    fetch: async (url, init) => {
      h.requests.push({ url, headers: init?.headers });
      if (url === DOWNLOAD) return new Response(INSTALLER);
      if (opts.feed === 204) return new Response(null, { status: 204 });
      const manifest = { version: '0.2.0', notes: 'Drag and drop uploads', url: DOWNLOAD, signature: (opts.signature ?? (() => goodSignature))() };
      return Response.json(manifest);
    },
    activity: () => h.activity,
    systemIdleSecs: () => h.idle.secs,
    launchInstaller: (name, _bytes, relaunch) => h.launched.push({ name, relaunch }),
    quitForInstall: () => h.quits++,
    status: (s) => h.statuses.push(s),
    notify: (n) => h.notices.push(n),
    log: () => undefined,
  };
  return Object.assign(h, { updater: new Updater(deps) }) as unknown as Harness;
}

afterEach(() => vi.useRealTimers());

describe('Updater.check', () => {
  it('asks the feed with the install id and reports being up to date on 204', async () => {
    const h = harness({ feed: 204 });
    await h.updater.start();
    await h.updater.check(true);
    h.updater.stop();
    expect(h.requests[0]!.url).toBe('https://feed.test/v1/updates/otherssh/windows/x86_64/0.1.0');
    expect(h.requests[0]!.headers?.['X-Install-Id']).toBe(h.store.value.installId);
    expect(h.store.value.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.notices).toEqual([{ kind: 'message', text: "You're up to date: OtherSSH 0.1.0 is the latest version.", tone: 'info' }]);
  });

  it('downloads and verifies a newer release, then waits quietly in automatic mode', async () => {
    const h = harness();
    await h.updater.start();
    await h.updater.check(false);
    h.updater.stop();
    expect(h.updater.status.ready).toEqual({ version: '0.2.0', notes: 'Drag and drop uploads' });
    expect(h.updater.status.status).toMatch(/will install when you close OtherSSH/);
    expect(h.notices).toEqual([]);
    expect(h.store.value.pendingSince?.from).toBe('0.1.0');
  });

  it('offers the restart in "ask" mode', async () => {
    const h = harness();
    h.mode.value = 'ask';
    await h.updater.start();
    await h.updater.check(false);
    h.updater.stop();
    expect(h.notices).toEqual([{ kind: 'ready', version: '0.2.0' }]);
  });

  it('refuses a download whose signature does not match', async () => {
    const h = harness({ signature: () => badSignature });
    await h.updater.start();
    await h.updater.check(true);
    h.updater.stop();
    expect(h.updater.status.ready).toBeNull();
    expect(h.notices[0]).toMatchObject({ kind: 'message', tone: 'error' });
    expect((h.notices[0] as { text: string }).text).toMatch(/does not match/);
  });

  it('refuses an old signed installer passed off as a newer version', async () => {
    const h = harness({ signature: () => oldSignature });
    await h.updater.start();
    await h.updater.check(true);
    h.updater.stop();
    expect(h.updater.status.ready).toBeNull();
    expect((h.notices[0] as { text: string }).text).toMatch(/OtherSSH_0\.0\.9_x64-setup\.exe, not 0\.2\.0/);
  });

  it('stops a download as soon as it passes the size cap', async () => {
    const h = harness();
    let pulled = 0;
    const huge = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(64 * 1024 * 1024));
      },
    });
    const deps = (h.updater as unknown as { deps: UpdaterDeps }).deps;
    const feedFetch = deps.fetch;
    deps.fetch = async (url, init) => (url === DOWNLOAD ? new Response(huge) : feedFetch(url, init));
    await h.updater.start();
    await h.updater.check(true);
    h.updater.stop();
    expect((h.notices[0] as { text: string }).text).toMatch(/too large/);
    expect(pulled).toBeLessThan(10); // 400 MB cap at 64 MB a chunk, not the whole stream
  });

  it('skips the timed check when updates are off', async () => {
    const h = harness();
    h.mode.value = 'off';
    await h.updater.start();
    await h.updater.check(false);
    h.updater.stop();
    expect(h.requests).toHaveLength(0);
  });
});

describe('installing', () => {
  async function ready(h: Harness): Promise<void> {
    await h.updater.start();
    await h.updater.check(false);
    h.updater.stop();
  }

  it('installs on quit without starting again, and records the attempt', async () => {
    const h = harness();
    await ready(h);
    h.activity.liveSessions = 2; // the user already agreed to close them
    await h.updater.onQuit();
    expect(h.launched).toEqual([{ name: 'OtherSSH_0.2.0_x64-setup.exe', relaunch: false }]);
    expect(h.quits).toBe(0);
    expect(h.store.value.attempt).toMatchObject({ version: '0.2.0', from: '0.1.0', notes: 'Drag and drop uploads' });
    expect(h.updater.onQuit()).toBeNull(); // not twice
  });

  it('does not install on quit in "ask" mode', async () => {
    const h = harness();
    h.mode.value = 'ask';
    await ready(h);
    expect(h.updater.onQuit()).toBeNull();
    expect(h.launched).toHaveLength(0);
  });

  it('installs and restarts while the user is away with nothing open, but not over a connection', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.updater.start();
    await h.updater.check(false);
    h.idle.secs = IDLE_SECS;
    h.activity.liveSessions = 1;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(h.launched).toHaveLength(0);
    h.activity.liveSessions = 0;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    h.updater.stop();
    expect(h.launched).toEqual([{ name: 'OtherSSH_0.2.0_x64-setup.exe', relaunch: true }]);
    expect(h.quits).toBe(1);
  });

  it('lets "Restart now" go ahead with connections open, but not during an upload', async () => {
    const h = harness();
    await ready(h);
    h.activity.transfers = 1;
    await expect(h.updater.installNow()).rejects.toThrow(/upload/);
    h.activity.transfers = 0;
    h.activity.liveSessions = 3;
    await h.updater.installNow();
    expect(h.launched).toEqual([{ name: 'OtherSSH_0.2.0_x64-setup.exe', relaunch: true }]);
    expect(h.quits).toBe(1);
  });
});

describe('after an install', () => {
  it('says once that the update worked', async () => {
    const h = harness({ version: '0.2.0', state: { attempt: { version: '0.2.0', from: '0.1.0', notes: 'Uploads', at: 1 } } });
    await h.updater.start();
    h.updater.stop();
    expect(h.notices).toEqual([{ kind: 'updated', version: '0.2.0', notes: 'Uploads' }]);
    expect(h.store.value.attempt).toBeUndefined();
  });

  it('logs a failed install only once and stays quiet about it', async () => {
    const h = harness({ state: { attempt: { version: '0.2.0', from: '0.1.0', at: 1 } } });
    await h.updater.start();
    h.updater.stop();
    expect(h.notices).toEqual([]);
    expect(h.store.value.attempt?.failureLogged).toBe(true);
  });
});
