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
  /** What happens once an update has downloaded: install by itself, offer it, or never check. */
  updateMode: UpdateMode;
  updateChannel: UpdateChannel;
}

export type UpdateMode = 'auto' | 'ask' | 'off';
export type UpdateChannel = 'stable' | 'beta';

/** What Settings shows about updates. */
export interface UpdateStatus {
  /** The running version. */
  version: string;
  checking: boolean;
  /** A downloaded, signature-checked update waiting to install. */
  ready: { version: string; notes?: string } | null;
  /** One line for Settings: up to date, ready, or what went wrong. */
  status: string;
  /** This build can install updates itself (the installed app on Windows). */
  canInstall: boolean;
}

/** A toast the updater wants shown, in the focused window only. */
export type UpdateNotice =
  /** "Download and ask me": offer the restart. */
  | { kind: 'ready'; version: string }
  /** Automatic mode, but it has waited days for a quiet moment. */
  | { kind: 'nudge'; version: string }
  /** The update the last run started has installed. */
  | { kind: 'updated'; version: string; notes?: string }
  | { kind: 'message'; text: string; tone: 'info' | 'error' };

export interface OpenResult {
  sessionId: string;
  title: string;
  /** The secret the server's prompt hook echoes back with its folder; '' when there is none. */
  cwdToken: string;
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
  cwdToken: string;
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
  /** Update toasts raised before this window existed (such as "OtherSSH was updated"). */
  updateNotices: UpdateNotice[];
}

export type TabCommand =
  | { kind: 'close' }
  | { kind: 'teach' }
  | { kind: 'moveToNewWindow' }
  | { kind: 'moveToWindow'; windowId: number };

export type ProfileCommand = 'connect' | 'edit' | 'duplicate' | 'delete';

/** How a drag-and-drop upload ended. */
export type UploadResult =
  | { kind: 'done' }
  /** Not writable as the login user: files are parked in ~/.otherssh-upload and `command` (a sudo mv) finishes the job. */
  | { kind: 'staged'; command: string };

/** Outcome of adding the directory-reporting snippet to the server's ~/.bashrc. */
export type TeachResult = { kind: 'done' } | { kind: 'already' } | { kind: 'unsupported'; shell: string };

/** `[user@]host[:port]` typed into the filter box for a one-off connection. */
export interface QuickTarget {
  user?: string;
  host: string;
  port?: number;
}

export interface OtherSshApi {
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

  // file transfer
  /** Local path of a file or folder dropped from Explorer. */
  pathForFile(file: File): string;
  uploadFiles(sessionId: string, localPaths: string[], remoteDir: string): Promise<UploadResult>;
  teachServer(sessionId: string): Promise<TeachResult>;

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

  // updates
  getUpdateStatus(): Promise<UpdateStatus>;
  /** A manual check: every outcome comes back as a notice. */
  checkForUpdates(): Promise<void>;
  /** Restart now and install; asks first if connections are open, throws with the reason if it can't. */
  installUpdate(): Promise<void>;
  /** Whether a dialog or the upload folder question is open; an update never installs over one. */
  reportModal(open: boolean): void;

  // events; each returns an unsubscribe function
  onSessionData(cb: (sessionId: string, chunk: string) => void): () => void;
  onSessionExit(cb: (sessionId: string, exitCode: number) => void): () => void;
  onAdoptSession(cb: (adoption: Adoption) => void): () => void;
  onTabCommand(cb: (sessionId: string, cmd: TabCommand) => void): () => void;
  onProfileCommand(cb: (profileId: string, cmd: ProfileCommand) => void): () => void;
  onProfilesChanged(cb: (profiles: SessionProfile[]) => void): () => void;
  onSettingsChanged(cb: (settings: Settings) => void): () => void;
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void;
  onUpdateNotice(cb: (notice: UpdateNotice) => void): () => void;
}
