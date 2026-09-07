import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager, type PtyLike, type SpawnRequest } from './session-manager';

class FakePty implements PtyLike {
  dataCb: ((d: string) => void) | null = null;
  exitCb: ((e: { exitCode: number }) => void) | null = null;
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  constructor(public readonly cols: number, public readonly rows: number) {}
  onData(cb: (d: string) => void) { this.dataCb = cb; return { dispose: () => { this.dataCb = null; } }; }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCb = cb; return { dispose: () => { this.exitCb = null; } }; }
  write(d: string) { this.written.push(d); }
  resize(cols: number, rows: number) { this.resized.push([cols, rows]); }
  kill() { this.killed = true; }
  emit(d: string) { this.dataCb?.(d); }
  exit(code: number) { this.exitCb?.({ exitCode: code }); }
}

let spawned: Array<{ req: SpawnRequest; pty: FakePty }>;
let sent: Array<[number, string, unknown[]]>;
let deadWindows: Set<number>;
let manager: SessionManager;

const req = (over: Partial<SpawnRequest> = {}): SpawnRequest => ({
  profileId: 'p1', title: 'Webserver', file: 'C:\\ssh.exe', args: ['webserver'], cols: 80, rows: 24, ownerWc: 1, ...over,
});

beforeEach(() => {
  spawned = [];
  sent = [];
  deadWindows = new Set();
  manager = new SessionManager({
    spawn: (r) => { const pty = new FakePty(r.cols, r.rows); spawned.push({ req: r, pty }); return pty; },
    send: (wc, channel, ...args) => { if (deadWindows.has(wc)) return false; sent.push([wc, channel, args]); return true; },
  });
});

describe('SessionManager.open', () => {
  it('spawns ssh with the given binary and argv and returns a session id', () => {
    const result = manager.open(req());
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.req).toMatchObject({ file: 'C:\\ssh.exe', args: ['webserver'], cols: 80, rows: 24 });
    expect(result.sessionId).toBeTruthy();
    expect(result.title).toBe('Webserver');
  });

  it('routes pty output to the owning window', () => {
    const { sessionId } = manager.open(req({ ownerWc: 7 }));
    spawned[0]!.pty.emit('hello');
    expect(sent).toEqual([[7, 'session:data', [sessionId, 'hello']]]);
  });

  it('tells the owning window when the process exits and marks the session dead', () => {
    const { sessionId } = manager.open(req({ ownerWc: 7 }));
    spawned[0]!.pty.exit(3);
    expect(sent).toEqual([[7, 'session:exit', [sessionId, 3]]]);
    expect(manager.isAlive(sessionId)).toBe(false);
  });
});

describe('SessionManager input', () => {
  it('forwards writes and resizes from the owner to the pty', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    manager.write(sessionId, 'ls\r', 1);
    manager.resize(sessionId, 100, 30, 1);
    expect(spawned[0]!.pty.written).toEqual(['ls\r']);
    expect(spawned[0]!.pty.resized).toEqual([[100, 30]]);
  });

  it('ignores writes from a window that does not own the session', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    manager.write(sessionId, 'rm -rf /\r', 2);
    expect(spawned[0]!.pty.written).toEqual([]);
  });

  it('ignores a resize to the dimensions the pty already has', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1, cols: 80, rows: 24 }));
    manager.resize(sessionId, 80, 24, 1);
    expect(spawned[0]!.pty.resized).toEqual([]);
  });
});

describe('SessionManager lifecycle', () => {
  it('kill() terminates the pty but keeps the record for the dead-tab UI', () => {
    const { sessionId } = manager.open(req());
    manager.kill(sessionId);
    expect(spawned[0]!.pty.killed).toBe(true);
    expect(manager.has(sessionId)).toBe(true);
  });

  it('close() terminates the pty and forgets the session', () => {
    const { sessionId } = manager.open(req());
    manager.close(sessionId);
    expect(spawned[0]!.pty.killed).toBe(true);
    expect(manager.has(sessionId)).toBe(false);
  });

  it('reconnect() respawns the same binary and argv under the same session id', () => {
    const { sessionId } = manager.open(req({ args: ['-p', '2222', 'alice@h'] }));
    spawned[0]!.pty.exit(255);
    const again = manager.reconnect(sessionId, 90, 25, 1);
    expect(again.sessionId).toBe(sessionId);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.req).toMatchObject({ file: 'C:\\ssh.exe', args: ['-p', '2222', 'alice@h'], cols: 90, rows: 25 });
    spawned[1]!.pty.emit('back');
    expect(sent.at(-1)).toEqual([1, 'session:data', [sessionId, 'back']]);
  });

  it('dropOwner() kills and forgets every session a closed window owned', () => {
    const a = manager.open(req({ ownerWc: 1 }));
    const b = manager.open(req({ ownerWc: 2 }));
    manager.dropOwner(1);
    expect(spawned[0]!.pty.killed).toBe(true);
    expect(manager.has(a.sessionId)).toBe(false);
    expect(spawned[1]!.pty.killed).toBe(false);
    expect(manager.has(b.sessionId)).toBe(true);
  });

  it('liveCountFor() counts only running sessions owned by that window', () => {
    manager.open(req({ ownerWc: 1 }));
    const dead = manager.open(req({ ownerWc: 1 }));
    manager.open(req({ ownerWc: 2 }));
    spawned[1]!.pty.exit(0);
    expect(manager.liveCountFor(1)).toBe(1);
    expect(dead.sessionId).toBeTruthy();
  });
});

describe('SessionManager tear-off handoff', () => {
  it('detach() stops output reaching the old owner and buffers it until attach() replays it in order', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    manager.detach(sessionId, 1);
    spawned[0]!.pty.emit('one');
    spawned[0]!.pty.emit('two');
    expect(sent).toEqual([]);
    const result = manager.attach(sessionId, 80, 24, 2);
    expect(result).toEqual({ alive: true });
    expect(sent).toEqual([
      [2, 'session:data', [sessionId, 'one']],
      [2, 'session:data', [sessionId, 'two']],
    ]);
    spawned[0]!.pty.emit('three');
    expect(sent.at(-1)).toEqual([2, 'session:data', [sessionId, 'three']]);
  });

  it('attach() resizes the pty only when the new terminal has different dimensions', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1, cols: 80, rows: 24 }));
    manager.detach(sessionId, 1);
    manager.attach(sessionId, 80, 24, 2);
    expect(spawned[0]!.pty.resized).toEqual([]);
    manager.detach(sessionId, 2);
    manager.attach(sessionId, 120, 40, 3);
    expect(spawned[0]!.pty.resized).toEqual([[120, 40]]);
  });

  it('delivers an exit that happened while detached after the replayed output', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    manager.detach(sessionId, 1);
    spawned[0]!.pty.emit('bye');
    spawned[0]!.pty.exit(0);
    const result = manager.attach(sessionId, 80, 24, 2);
    expect(result).toEqual({ alive: false, exitCode: 0 });
    expect(sent).toEqual([
      [2, 'session:data', [sessionId, 'bye']],
      [2, 'session:exit', [sessionId, 0]],
    ]);
  });

  it('refuses attach() for a session that was not detached', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    expect(() => manager.attach(sessionId, 80, 24, 2)).toThrow(/detached/i);
  });

  it('refuses detach() from a window that does not own the session', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    expect(() => manager.detach(sessionId, 2)).toThrow(/own/i);
  });

  it('keeps only the tail of the handoff buffer, with a marker, when it overflows', () => {
    manager = new SessionManager({
      spawn: (r) => { const pty = new FakePty(r.cols, r.rows); spawned.push({ req: r, pty }); return pty; },
      send: (wc, channel, ...args) => { sent.push([wc, channel, args]); return true; },
      handoffLimit: 10,
    });
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    manager.detach(sessionId, 1);
    spawned[0]!.pty.emit('aaaaaaaa');
    spawned[0]!.pty.emit('bbbbbbbb');
    manager.attach(sessionId, 80, 24, 2);
    const replayed = sent.map(([, , args]) => args[1] as string).join('');
    expect(replayed).toContain('truncated');
    expect(replayed.endsWith('bbbbbbbb')).toBe(true);
    expect(replayed).not.toContain('aaaaaaaa');
  });

  it('orphans() lists detached sessions whose previous owner is known so a failed move can be undone', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    manager.detach(sessionId, 1);
    expect(manager.orphans()).toEqual([{ sessionId, prevOwnerWc: 1 }]);
    manager.attach(sessionId, 80, 24, 2);
    expect(manager.orphans()).toEqual([]);
  });
});

describe('SessionManager.get', () => {
  it('reports the exit code once the process has ended', () => {
    const { sessionId } = manager.open(req({ ownerWc: 1 }));
    expect(manager.get(sessionId)).toMatchObject({ alive: true, exitCode: undefined });
    spawned[0]!.pty.exit(130);
    expect(manager.get(sessionId)).toMatchObject({ alive: false, exitCode: 130 });
  });
});
