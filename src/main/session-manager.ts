import { randomUUID } from 'node:crypto';
import type { AttachResult, OpenResult, SessionProfile } from '../shared/types';

/** The slice of node-pty's IPty we use; injected so the manager is testable without a real pty. */
export interface PtyLike {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnRequest {
  profileId: string;
  title: string;
  file: string;
  args: string[];
  cols: number;
  rows: number;
  /** webContents id of the window that will display the session. */
  ownerWc: number;
  /** What the session connected with; uploads reuse it to reach the same server. */
  profile?: SessionProfile;
  /** Handed to the server in the ssh args; the renderer trusts folder reports that carry it. */
  cwdToken?: string;
}

export interface SessionManagerDeps {
  spawn(request: SpawnRequest): PtyLike;
  /** Deliver an event to a window; returns false if that window is gone. */
  send(wcId: number, channel: string, ...args: unknown[]): boolean;
  /** Max bytes buffered while a session is between windows (default 4 MB). */
  handoffLimit?: number;
}

export interface SessionInfo {
  sessionId: string;
  profileId: string;
  title: string;
  alive: boolean;
  exitCode: number | undefined;
  ownerWc: number | null;
  profile: SessionProfile | undefined;
  cwdToken: string;
}

interface SessionRecord {
  id: string;
  profileId: string;
  profile: SessionProfile | undefined;
  cwdToken: string;
  title: string;
  file: string;
  args: string[];
  pty: PtyLike | null;
  cols: number;
  rows: number;
  ownerWc: number | null;
  prevOwnerWc: number | null;
  detached: boolean;
  handoff: string[];
  handoffBytes: number;
  truncated: boolean;
  pendingExit: number | undefined;
  exitCode: number | undefined;
  disposables: Array<{ dispose(): void }>;
}

const TRUNCATION_MARKER = '\r\n\x1b[90m[... output truncated while moving the tab ...]\x1b[0m\r\n';

/**
 * Owns every live ssh process. Renderer windows are only views: a session can
 * be detached from one window and attached to another without touching the pty.
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly handoffLimit: number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.handoffLimit = deps.handoffLimit ?? 4 * 1024 * 1024;
  }

  open(request: SpawnRequest): OpenResult {
    const record: SessionRecord = {
      id: randomUUID(),
      profileId: request.profileId,
      profile: request.profile,
      cwdToken: request.cwdToken ?? '',
      title: request.title,
      file: request.file,
      args: request.args,
      pty: null,
      cols: request.cols,
      rows: request.rows,
      ownerWc: request.ownerWc,
      prevOwnerWc: null,
      detached: false,
      handoff: [],
      handoffBytes: 0,
      truncated: false,
      pendingExit: undefined,
      exitCode: undefined,
      disposables: [],
    };
    this.sessions.set(record.id, record);
    this.spawnInto(record, request.cols, request.rows, request.ownerWc);
    return { sessionId: record.id, title: record.title, cwdToken: record.cwdToken };
  }

  reconnect(sessionId: string, cols: number, rows: number, fromWc: number): OpenResult {
    const record = this.require(sessionId);
    if (record.pty) throw new Error('Session is still running');
    if (record.ownerWc !== fromWc) throw new Error('Window does not own this session');
    this.disposeListeners(record);
    this.spawnInto(record, cols, rows, fromWc);
    return { sessionId: record.id, title: record.title, cwdToken: record.cwdToken };
  }

  write(sessionId: string, data: string, fromWc: number): void {
    const record = this.sessions.get(sessionId);
    if (!record?.pty || record.ownerWc !== fromWc) return;
    record.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number, fromWc: number): void {
    const record = this.sessions.get(sessionId);
    if (!record?.pty || record.ownerWc !== fromWc) return;
    this.applySize(record, cols, rows);
  }

  kill(sessionId: string): void {
    this.sessions.get(sessionId)?.pty?.kill();
  }

  close(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    this.disposeListeners(record);
    record.pty?.kill();
    record.pty = null;
    this.sessions.delete(sessionId);
  }

  detach(sessionId: string, fromWc: number): void {
    const record = this.require(sessionId);
    if (record.ownerWc !== fromWc) throw new Error('Window does not own this session');
    record.detached = true;
    record.prevOwnerWc = fromWc;
    record.ownerWc = null;
  }

  attach(sessionId: string, cols: number, rows: number, toWc: number): AttachResult {
    const record = this.require(sessionId);
    if (!record.detached) throw new Error('Session is not detached');
    record.detached = false;
    record.ownerWc = toWc;
    record.prevOwnerWc = null;

    if (record.truncated) this.deps.send(toWc, 'session:data', record.id, TRUNCATION_MARKER);
    for (const chunk of record.handoff) this.deps.send(toWc, 'session:data', record.id, chunk);
    record.handoff = [];
    record.handoffBytes = 0;
    record.truncated = false;

    if (record.pendingExit !== undefined) {
      this.deps.send(toWc, 'session:exit', record.id, record.pendingExit);
      record.pendingExit = undefined;
    }

    if (record.pty) this.applySize(record, cols, rows);
    else {
      record.cols = cols;
      record.rows = rows;
    }
    return { alive: record.pty !== null, exitCode: record.exitCode };
  }

  /** Sessions stuck mid-move whose previous window is still known. */
  orphans(): Array<{ sessionId: string; prevOwnerWc: number }> {
    const out: Array<{ sessionId: string; prevOwnerWc: number }> = [];
    for (const r of this.sessions.values()) {
      if (r.detached && r.ownerWc === null && r.prevOwnerWc !== null) out.push({ sessionId: r.id, prevOwnerWc: r.prevOwnerWc });
    }
    return out;
  }

  /** A window went away: terminate everything it displayed, forget it as a fallback owner. */
  dropOwner(wcId: number): void {
    for (const r of [...this.sessions.values()]) {
      if (r.ownerWc === wcId) this.close(r.id);
      else if (r.prevOwnerWc === wcId) r.prevOwnerWc = null;
    }
  }

  /** Live connections in every window, for the updater: it never restarts over one by itself. */
  liveCount(): number {
    let n = 0;
    for (const r of this.sessions.values()) if (r.pty) n++;
    return n;
  }

  liveCountFor(wcId: number): number {
    let n = 0;
    for (const r of this.sessions.values()) if (r.ownerWc === wcId && r.pty) n++;
    return n;
  }

  ownedBy(wcId: number): string[] {
    return [...this.sessions.values()].filter((r) => r.ownerWc === wcId).map((r) => r.id);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isAlive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.pty !== null && this.sessions.has(sessionId);
  }

  get(sessionId: string): SessionInfo | undefined {
    const r = this.sessions.get(sessionId);
    if (!r) return undefined;
    return { sessionId: r.id, profileId: r.profileId, title: r.title, alive: r.pty !== null, exitCode: r.exitCode, ownerWc: r.ownerWc, profile: r.profile, cwdToken: r.cwdToken };
  }

  ownerOf(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.ownerWc ?? null;
  }

  private spawnInto(record: SessionRecord, cols: number, rows: number, ownerWc: number): void {
    record.cols = cols;
    record.rows = rows;
    record.ownerWc = ownerWc;
    record.prevOwnerWc = null;
    record.detached = false;
    record.handoff = [];
    record.handoffBytes = 0;
    record.truncated = false;
    record.pendingExit = undefined;
    record.exitCode = undefined;

    const pty = this.deps.spawn({
      profileId: record.profileId,
      title: record.title,
      file: record.file,
      args: record.args,
      cols,
      rows,
      ownerWc,
    });
    record.pty = pty;
    record.disposables = [
      pty.onData((data) => this.onData(record, data)),
      pty.onExit(({ exitCode }) => this.onExit(record, exitCode)),
    ];
  }

  private onData(record: SessionRecord, data: string): void {
    if (record.detached) {
      this.buffer(record, data);
      return;
    }
    if (record.ownerWc !== null) this.deps.send(record.ownerWc, 'session:data', record.id, data);
  }

  private onExit(record: SessionRecord, exitCode: number): void {
    record.pty = null;
    record.exitCode = exitCode;
    if (record.detached) {
      record.pendingExit = exitCode;
      return;
    }
    if (record.ownerWc !== null) this.deps.send(record.ownerWc, 'session:exit', record.id, exitCode);
  }

  private buffer(record: SessionRecord, data: string): void {
    record.handoff.push(data);
    record.handoffBytes += data.length;
    while (record.handoffBytes > this.handoffLimit && record.handoff.length > 1) {
      const dropped = record.handoff.shift()!;
      record.handoffBytes -= dropped.length;
      record.truncated = true;
    }
    if (record.handoffBytes > this.handoffLimit && record.handoff.length === 1) {
      record.handoff[0] = record.handoff[0]!.slice(-this.handoffLimit);
      record.handoffBytes = record.handoff[0].length;
      record.truncated = true;
    }
  }

  private applySize(record: SessionRecord, cols: number, rows: number): void {
    if (cols === record.cols && rows === record.rows) return;
    record.cols = cols;
    record.rows = rows;
    record.pty?.resize(cols, rows);
  }

  private disposeListeners(record: SessionRecord): void {
    for (const d of record.disposables) d.dispose();
    record.disposables = [];
  }

  private require(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) throw new Error(`Unknown session ${sessionId}`);
    return record;
  }
}
