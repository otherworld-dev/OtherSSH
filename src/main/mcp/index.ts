import { randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { McpAction, McpRendererRequest, McpStatus, Settings } from '../../shared/types';
import { hasControlChars } from '../../shared/cwd-tracker';
import type { SessionManager } from '../session-manager';
import type { SessionStore } from '../session-store';
import type { SettingsStore } from '../settings';
import type { Transfers } from '../transfer';
import type { WindowManager } from '../windows';
import { startMcpServer, type McpHttpServer } from './server';
import { createMcpTools, McpToolError } from './tools';

export interface McpControllerDeps {
  settings: SettingsStore;
  profiles: SessionStore;
  sessions: SessionManager;
  windows: () => WindowManager | undefined;
  transfers: Transfers;
  version: string;
}

interface Pending {
  wcId: number;
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

const MAX_RECENT = 50;

export const newToken = (): string => randomBytes(24).toString('base64url');

/** Runs the MCP server while Settings has it on, and does Claude's tab work through the windows. */
export function createMcpController(deps: McpControllerDeps) {
  const pending = new Map<number, Pending>();
  let nextRequest = 1;
  const recent: McpAction[] = [];
  let server: McpHttpServer | null = null;
  let running: { port: number; token: string } | null = null;
  let status = 'Off';
  let queue: Promise<void> = Promise.resolve();

  const snapshot = (): McpStatus => ({ running: server !== null, status, recent: recent.slice(0, 20) });
  const publish = (): void => deps.windows()?.broadcast('mcp:status', snapshot());

  /** Ask a window to do something and wait for its answer. */
  const ask = <T>(wcId: number, request: McpRendererRequest, timeoutMs: number): Promise<T> => {
    const target = deps.windows()?.get(wcId);
    if (!target || target.win.isDestroyed()) return Promise.reject(new McpToolError('That OtherSSH window is gone.'));
    const id = nextRequest++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new McpToolError('OtherSSH did not answer in time.'));
      }, timeoutMs);
      pending.set(id, { wcId, resolve: resolve as (v: unknown) => void, reject, timer });
      target.win.webContents.send('mcp:request', id, request);
    });
  };

  const ownerOf = (sessionId: string): number => {
    const owner = deps.sessions.ownerOf(sessionId);
    if (owner === null) throw new McpToolError('That tab is moving between windows; try again in a moment.');
    return owner;
  };

  const tools = createMcpTools({
    profiles: () => deps.profiles.list(),
    sessions: () => deps.sessions.list(),
    openTab: (profileId) => {
      const win = deps.windows()?.noticeTarget();
      if (!win) throw new McpToolError('OtherSSH has no window open.');
      return ask(win.webContents.id, { kind: 'open', profileId }, 30_000);
    },
    readTab: (sessionId, lines) => ask<string>(ownerOf(sessionId), { kind: 'read', sessionId, lines }, 10_000),
    writeTab: (sessionId, data) => {
      const owner = ownerOf(sessionId);
      deps.sessions.write(sessionId, data, owner);
      deps.windows()?.get(owner)?.win.webContents.send('mcp:activity', sessionId);
    },
    closeTab: async (sessionId) => {
      const owner = deps.sessions.ownerOf(sessionId);
      if (owner === null) deps.sessions.close(sessionId);
      else await ask(owner, { kind: 'close', sessionId }, 10_000);
    },
    runCommand: (profile, command, timeoutMs) => deps.transfers.command(profile, command, timeoutMs),
    upload: (profile, paths, dir) => deps.transfers.upload(profile, paths, dir),
    checkLocalPath: async (path) => {
      if (!isAbsolute(path) || hasControlChars(path)) throw new McpToolError(`"${path}" is not an absolute local path.`);
      try {
        await stat(path);
      } catch {
        throw new McpToolError(`"${path}" does not exist on this PC.`);
      }
    },
    record: (action) => {
      recent.unshift({ at: Date.now(), ...action });
      recent.length = Math.min(recent.length, MAX_RECENT);
      publish();
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  const apply = async (settings: Settings): Promise<void> => {
    if (settings.mcpEnabled && !settings.mcpToken) {
      await deps.settings.update({ mcpToken: newToken() }); // its change event brings us back here with the token
      return;
    }
    const want = settings.mcpEnabled && settings.mcpToken ? { port: settings.mcpPort, token: settings.mcpToken } : null;
    if (want && running && want.port === running.port && want.token === running.token) return;
    if (!want && !server) return;

    if (server) {
      await server.close();
      server = null;
      running = null;
    }
    if (!want) {
      status = 'Off';
      publish();
      return;
    }
    try {
      server = await startMcpServer({ port: want.port, token: want.token, tools, version: deps.version });
      running = want;
      status = `Listening on http://127.0.0.1:${server.port}/mcp`;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      status = code === 'EADDRINUSE' ? `Port ${want.port} is already in use. Pick another port.` : `Couldn't start: ${(err as Error).message}`;
    }
    publish();
  };

  /** One change at a time, so a quick off-on can't leave two servers fighting for the port. */
  const schedule = (settings: Settings): void => {
    queue = queue.then(() => apply(settings)).catch(() => undefined);
  };

  return {
    start(): void {
      schedule(deps.settings.get());
      deps.settings.onChange(schedule);
    },
    status: snapshot,
    /** A window answered a request; only the window that was asked may answer it. */
    reply(fromWc: number, requestId: unknown, ok: unknown, value: unknown): void {
      if (typeof requestId !== 'number') return;
      const entry = pending.get(requestId);
      if (!entry || entry.wcId !== fromWc) return;
      pending.delete(requestId);
      clearTimeout(entry.timer);
      if (ok === true) entry.resolve(value);
      else entry.reject(new McpToolError(typeof value === 'string' ? value : 'OtherSSH could not do that.'));
    },
    async newToken(): Promise<Settings> {
      return deps.settings.update({ mcpToken: newToken() });
    },
    async stop(): Promise<void> {
      await queue;
      await server?.close();
      server = null;
    },
  };
}

export type McpController = ReturnType<typeof createMcpController>;
