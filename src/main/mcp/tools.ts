import type { McpAction, SessionProfile, UploadResult } from '../../shared/types';
import type { SessionInfo } from '../session-manager';
import type { RunResult } from '../transfer';
import { explainFailure } from '../transfer';

// What Claude can do through the MCP server, with no Electron in sight so it can
// be tested. Everything that touches a server is gated on the saved session's
// "Allow Claude" box, read fresh on every call so unticking it takes effect at once.

export interface McpToolDeps {
  /** Saved sessions, as they are now. */
  profiles(): SessionProfile[];
  /** Open tabs across every window. */
  sessions(): SessionInfo[];
  /** Open a saved session as a new tab in the app and wait for it to start. */
  openTab(profileId: string): Promise<{ sessionId: string; title: string }>;
  /** The tab's screen and scrollback as plain text, last `lines` lines. */
  readTab(sessionId: string, lines: number): Promise<string>;
  /** Type into the tab, as if from the keyboard. */
  writeTab(sessionId: string, data: string): void;
  closeTab(sessionId: string): Promise<void>;
  runCommand(profile: SessionProfile, command: string, timeoutMs: number): Promise<RunResult>;
  upload(profile: SessionProfile, localPaths: string[], remoteDir: string): Promise<UploadResult>;
  /** Throws if the local path is not absolute or doesn't exist. */
  checkLocalPath(path: string): Promise<void>;
  record(action: Omit<McpAction, 'at'>): void;
  sleep(ms: number): Promise<void>;
}

/** A refusal or bad input Claude should see as the tool's error text. */
export class McpToolError extends Error {}

export const KEYS = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  ctrl_c: '\x03',
  ctrl_d: '\x04',
  ctrl_l: '\x0c',
  ctrl_z: '\x1a',
} as const;
export type KeyName = keyof typeof KEYS;

export const LIMITS = {
  maxInput: 10_000,
  maxOutput: 50_000,
  defaultReadLines: 100,
  maxReadLines: 2000,
  replyLines: 40,
  defaultWaitMs: 1000,
  maxWaitMs: 30_000,
  defaultTimeoutS: 30,
  maxTimeoutS: 300,
};

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Keep the end: the last lines of output are usually the ones that matter. */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[... ${text.length - max} earlier characters cut ...]\n${text.slice(-max)}`;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function createMcpTools(deps: McpToolDeps) {
  /** A saved session by id or by name (case-insensitive). */
  const findProfile = (ref: string): SessionProfile => {
    const all = deps.profiles();
    const byId = all.find((p) => p.id === ref);
    if (byId) return byId;
    const named = all.filter((p) => p.name.toLowerCase() === ref.trim().toLowerCase());
    if (named.length === 1) return named[0]!;
    if (named.length > 1) throw new McpToolError(`More than one saved session is called "${ref}"; use its id: ${named.map((p) => p.id).join(', ')}`);
    throw new McpToolError(`No saved session "${ref}". Call list_sessions to see them.`);
  };

  const requireAllowed = (profile: SessionProfile): SessionProfile => {
    if (!profile.allowClaude) {
      throw new McpToolError(`"${profile.name}" is not open to Claude. Tick "Allow Claude" in that session's settings in OtherSSH.`);
    }
    return profile;
  };

  /** An open tab, and its saved session, which must allow Claude. */
  const findTab = (tabId: string): { info: SessionInfo; profile: SessionProfile } => {
    const info = deps.sessions().find((s) => s.sessionId === tabId);
    if (!info) throw new McpToolError(`No open tab "${tabId}". Call list_tabs to see them.`);
    const profile = deps.profiles().find((p) => p.id === info.profileId);
    if (!profile) throw new McpToolError(`Tab "${info.title}" is a one-off connection, not a saved session, so Claude can't use it.`);
    return { info, profile: requireAllowed(profile) };
  };

  /** Run one tool call, logging it for the activity list whether it worked or not. */
  const logged = async (tool: string, target: () => string | undefined, work: () => Promise<string>): Promise<string> => {
    let name: string | undefined;
    try {
      name = target();
    } catch {
      name = undefined;
    }
    try {
      const out = await work();
      deps.record({ tool, target: name, ok: true });
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.record({ tool, target: name, ok: false, detail: message });
      throw err instanceof McpToolError ? err : new McpToolError(message);
    }
  };

  const describeProfile = (p: SessionProfile) => ({
    id: p.id,
    name: p.name,
    host: p.host,
    ...(p.user ? { user: p.user } : {}),
    ...(p.port ? { port: p.port } : {}),
    ...(p.group ? { group: p.group } : {}),
    allowClaude: p.allowClaude === true,
  });

  const screenAfter = async (sessionId: string, waitMs: number): Promise<string> => {
    if (waitMs > 0) await deps.sleep(waitMs);
    return deps.readTab(sessionId, LIMITS.replyLines);
  };

  return {
    listSessions: (): Promise<string> =>
      logged('list_sessions', () => undefined, async () => JSON.stringify(deps.profiles().map(describeProfile), null, 2)),

    listTabs: (): Promise<string> =>
      logged('list_tabs', () => undefined, async () => {
        const profiles = new Map(deps.profiles().map((p) => [p.id, p]));
        const tabs = deps.sessions().map((s) => ({
          tab: s.sessionId,
          title: s.title,
          session: profiles.get(s.profileId)?.name ?? null,
          sessionId: s.profileId || null,
          connected: s.alive,
          ...(s.alive || s.exitCode === undefined ? {} : { exitCode: s.exitCode }),
          allowClaude: profiles.get(s.profileId)?.allowClaude === true,
        }));
        return JSON.stringify(tabs, null, 2);
      }),

    openTab: (session: string): Promise<string> =>
      logged('open_tab', () => findProfile(session).name, async () => {
        const profile = requireAllowed(findProfile(session));
        const { sessionId, title } = await deps.openTab(profile.id);
        const screen = await screenAfter(sessionId, 2000);
        return `Opened "${title}" as tab ${sessionId}.\n\nScreen so far:\n${screen}`;
      }),

    readTab: (tab: string, lines?: number): Promise<string> =>
      logged('read_tab', () => findTab(tab).info.title, async () => {
        const { info } = findTab(tab);
        const text = await deps.readTab(info.sessionId, clamp(lines, LIMITS.defaultReadLines, 1, LIMITS.maxReadLines));
        const state = info.alive ? '' : `\n\n[disconnected${info.exitCode === undefined ? '' : `, exit code ${info.exitCode}`}]`;
        return tail(text, LIMITS.maxOutput) + state;
      }),

    sendInput: (tab: string, opts: { text?: string; pressEnter?: boolean; keys?: KeyName[]; waitMs?: number }): Promise<string> =>
      logged('send_input', () => findTab(tab).info.title, async () => {
        const { info } = findTab(tab);
        if (!info.alive) throw new McpToolError(`Tab "${info.title}" is disconnected.`);
        const text = opts.text ?? '';
        if (text.length > LIMITS.maxInput) throw new McpToolError(`That is more than ${LIMITS.maxInput} characters; upload a file instead.`);
        let data = text.replace(/\r?\n/g, '\r');
        if (opts.pressEnter ?? true) data += KEYS.enter;
        for (const key of opts.keys ?? []) {
          if (!(key in KEYS)) throw new McpToolError(`Unknown key "${key}".`);
          data += KEYS[key];
        }
        if (!data) throw new McpToolError('Nothing to send: give text, keys or press_enter.');
        deps.writeTab(info.sessionId, data);
        const waitMs = clamp(opts.waitMs, LIMITS.defaultWaitMs, 0, LIMITS.maxWaitMs);
        return `Sent. Screen after ${waitMs} ms:\n${await screenAfter(info.sessionId, waitMs)}`;
      }),

    closeTab: (tab: string): Promise<string> =>
      logged('close_tab', () => findTab(tab).info.title, async () => {
        const { info } = findTab(tab);
        await deps.closeTab(info.sessionId);
        return `Closed tab "${info.title}".`;
      }),

    runCommand: (session: string, command: string, timeoutS?: number): Promise<string> =>
      logged('run_command', () => findProfile(session).name, async () => {
        const profile = requireAllowed(findProfile(session));
        if (!command.trim()) throw new McpToolError('The command is empty.');
        if (command.length > LIMITS.maxInput) throw new McpToolError(`That command is more than ${LIMITS.maxInput} characters.`);
        const seconds = clamp(timeoutS, LIMITS.defaultTimeoutS, 1, LIMITS.maxTimeoutS);
        const result = await deps.runCommand(profile, command, seconds * 1000);
        // ssh itself exits 255 when it can't connect or log in; the command's own code otherwise.
        if (result.code === 255 && !result.stdout && /Permission denied \(|No more authentication methods|Too many authentication failures/i.test(result.stderr)) {
          throw new McpToolError(
            `Couldn't log in to "${profile.name}" without a password. run_command needs key or agent login; ` +
              'for a password-only server, use open_tab and let the user type the password.',
          );
        }
        if (result.code === 255 && !result.stdout && /ssh:|Host key/i.test(result.stderr)) {
          throw new McpToolError(`Couldn't connect: ${explainFailure(result.stderr)}`);
        }
        const parts = [result.timedOut ? `Stopped after ${seconds} s (time limit).` : `Exit code ${result.code}.`];
        const stdout = stripAnsi(result.stdout).trimEnd();
        const stderr = stripAnsi(result.stderr).trimEnd();
        if (stdout) parts.push(`stdout:\n${tail(stdout, LIMITS.maxOutput)}`);
        if (stderr) parts.push(`stderr:\n${tail(stderr, LIMITS.maxOutput)}`);
        if (!stdout && !stderr) parts.push('(no output)');
        return parts.join('\n\n');
      }),

    uploadFile: (session: string, localPaths: string[], remoteDir: string): Promise<string> =>
      logged('upload_file', () => findProfile(session).name, async () => {
        const profile = requireAllowed(findProfile(session));
        if (localPaths.length === 0) throw new McpToolError('No local paths given.');
        for (const p of localPaths) await deps.checkLocalPath(p);
        const result = await deps.upload(profile, localPaths, remoteDir);
        if (result.kind === 'done') return `Uploaded ${localPaths.length} item(s) to ${remoteDir} on ${profile.name}.`;
        return (
          `${remoteDir} needs root, so the upload is parked in the login user's home. ` +
          `To finish it, the user must run this themselves (it asks for their sudo password):\n${result.command}`
        );
      }),
  };
}

export type McpTools = ReturnType<typeof createMcpTools>;
