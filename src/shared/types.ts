// Single source of truth for everything that crosses the main <-> renderer boundary.

export interface SessionProfile {
  id: string;
  name: string;
  /** A hostname, or an alias from ~/.ssh/config (ssh resolves it; we never parse the config). */
  host: string;
  user?: string;
  port?: number;
  /** Path to a private key, passed as `-i`. Leave blank to let ssh/agent/config decide. */
  identityFile?: string;
  /** Extra argv passed verbatim to ssh before the destination (e.g. `-o ServerAliveInterval=30`). */
  extraArgs?: string[];
  /** Sidebar group name. Flat, free text; blank means ungrouped. */
  group?: string;
}

export interface Settings {
  /** Explicit ssh binary; when unset the app prefers the Windows System32 OpenSSH build. */
  sshPath?: string;
  fontFamily: string;
  fontSize: number;
  scrollback: number;
}

export interface OpenResult {
  sessionId: string;
  title: string;
}

export interface AttachResult {
  alive: boolean;
  exitCode?: number;
}

export interface WindowInfo {
  id: number;
  title: string;
  tabCount: number;
}

/** A session being handed to a window during tear-off / move. */
export interface Adoption {
  sessionId: string;
  title: string;
  /** xterm serialize-addon output: screen + scrollback + modes. */
  serialized: string;
  alive: boolean;
  exitCode?: number;
}

export interface WindowInitState {
  windowId: number;
  tornOff: boolean;
  adoptions: Adoption[];
  settings: Settings;
  profiles: SessionProfile[];
  resolvedSshPath: string | null;
  windowsBuildNumber?: number;
  isPackaged: boolean;
}

export type TabCommand =
  | { kind: 'close' }
  | { kind: 'moveToNewWindow' }
  | { kind: 'moveToWindow'; windowId: number };

export type ProfileCommand = 'connect' | 'edit' | 'duplicate' | 'delete';

/** `[user@]host[:port]` typed into the filter box for a one-off connection. */
export interface QuickTarget {
  user?: string;
  host: string;
  port?: number;
}

export interface SshitApi {
  // profiles / settings
  listProfiles(): Promise<SessionProfile[]>;
  saveProfile(profile: SessionProfile): Promise<SessionProfile>;
  deleteProfile(id: string): Promise<void>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  resolveSshPath(): Promise<string | null>;
  browseForFile(defaultPath?: string): Promise<string | undefined>;
  /** Aliases in ~/.ssh/config that have no saved session yet. */
  listImportableHosts(): Promise<string[]>;
  /** Save a session for each importable alias; returns how many were added. */
  importSshConfig(): Promise<number>;
  showProfileContextMenu(profileId: string): void;

  // sessions
  openSession(profileId: string, cols: number, rows: number): Promise<OpenResult>;
  openQuickSession(target: QuickTarget, cols: number, rows: number): Promise<OpenResult>;
  reconnectSession(sessionId: string, cols: number, rows: number): Promise<OpenResult>;
  writeSession(sessionId: string, data: string): void;
  resizeSession(sessionId: string, cols: number, rows: number): void;
  killSession(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;

  // tear-off
  detachSession(sessionId: string): Promise<void>;
  moveSessionToNewWindow(sessionId: string, serialized: string): Promise<void>;
  moveSessionToWindow(sessionId: string, windowId: number, serialized: string): Promise<void>;
  attachSession(sessionId: string, cols: number, rows: number): Promise<AttachResult>;

  // windows
  getWindowInitState(): Promise<WindowInitState>;
  listOtherWindows(): Promise<WindowInfo[]>;
  showTabContextMenu(sessionId: string): void;
  setWindowTitle(title: string): void;
  closeWindow(): void;
  confirm(message: string): Promise<boolean>;
  info(message: string): Promise<void>;
  /** http(s) only; opens in the default browser. */
  openExternal(url: string): void;

  // clipboard (via main: no focus or permission requirements)
  readClipboard(): Promise<string>;
  writeClipboard(text: string): void;

  // events; each returns an unsubscribe function
  onSessionData(cb: (sessionId: string, chunk: string) => void): () => void;
  onSessionExit(cb: (sessionId: string, exitCode: number) => void): () => void;
  onAdoptSession(cb: (adoption: Adoption) => void): () => void;
  onTabCommand(cb: (sessionId: string, cmd: TabCommand) => void): () => void;
  onProfileCommand(cb: (profileId: string, cmd: ProfileCommand) => void): () => void;
  onProfilesChanged(cb: (profiles: SessionProfile[]) => void): () => void;
  onSettingsChanged(cb: (settings: Settings) => void): () => void;
}
