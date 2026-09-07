import { app, BrowserWindow, dialog, screen } from 'electron';
import { join } from 'node:path';
import type { Adoption, WindowInfo } from '../shared/types';
import type { JsonStore } from './json-store';
import type { SessionManager } from './session-manager';
import { boundsOnSomeDisplay, type Bounds } from './window-bounds';

interface WindowState {
  win: BrowserWindow;
  tornOff: boolean;
  /** Sessions this window must pick up on first load (tear-off target). */
  adoptions: Adoption[];
  title: string;
  forceClose: boolean;
}

/** Persisted size/position of the main (non-torn-off) window. */
export interface WindowStateFile {
  bounds?: Bounds;
  maximized?: boolean;
}

const DEFAULT_SIZE = { width: 1100, height: 700 };

/** Tracks every BrowserWindow, keyed by its webContents id (the IPC routing key). */
export class WindowManager {
  private readonly windows = new Map<number, WindowState>();
  /** sessionId -> webContents id of the window a detached session is travelling to. */
  private readonly pendingMoves = new Map<string, number>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly stateStore: JsonStore<WindowStateFile>,
    private saved: WindowStateFile,
  ) {}

  create(opts: { tornOff: boolean; adoptions?: Adoption[] }): BrowserWindow {
    const displays = screen.getAllDisplays().map((d) => d.workArea);
    const remembered = this.saved.bounds && boundsOnSomeDisplay(this.saved.bounds, displays) ? this.saved.bounds : undefined;
    const offset = opts.tornOff ? 40 : 0; // a torn-off window should not sit exactly on top of its parent

    const win = new BrowserWindow({
      width: remembered?.width ?? DEFAULT_SIZE.width,
      height: remembered?.height ?? DEFAULT_SIZE.height,
      ...(remembered ? { x: remembered.x + offset, y: remembered.y + offset } : {}),
      minWidth: 480,
      minHeight: 300,
      backgroundColor: '#14161a',
      show: false,
      autoHideMenuBar: true,
      title: 'SSHIT',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const wcId = win.webContents.id;
    const state: WindowState = { win, tornOff: opts.tornOff, adoptions: opts.adoptions ?? [], title: '', forceClose: false };
    this.windows.set(wcId, state);

    win.once('ready-to-show', () => {
      if (!opts.tornOff && this.saved.maximized) win.maximize();
      win.show();
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    if (!app.isPackaged) {
      win.webContents.on('before-input-event', (_e, input) => {
        if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
      });
    }
    win.on('close', (e) => this.onClose(state, e));
    win.on('closed', () => this.onClosed(wcId));

    if (!opts.tornOff) {
      let timer: NodeJS.Timeout | undefined;
      const persist = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => this.rememberBounds(win), 300);
      };
      win.on('resize', persist);
      win.on('move', persist);
      win.on('maximize', persist);
      win.on('unmaximize', persist);
    }

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl) void win.loadURL(devUrl);
    else void win.loadFile(join(__dirname, '../renderer/index.html'));
    return win;
  }

  get(wcId: number): WindowState | undefined {
    return this.windows.get(wcId);
  }

  has(wcId: number): boolean {
    return this.windows.has(wcId);
  }

  takeAdoptions(wcId: number): Adoption[] {
    const state = this.windows.get(wcId);
    if (!state) return [];
    const adoptions = state.adoptions;
    state.adoptions = [];
    return adoptions;
  }

  isTornOff(wcId: number): boolean {
    return this.windows.get(wcId)?.tornOff ?? false;
  }

  setTitle(wcId: number, title: string): void {
    const state = this.windows.get(wcId);
    if (!state) return;
    state.title = title;
    state.win.setTitle(title ? `${title} - SSHIT` : 'SSHIT');
  }

  listOthers(wcId: number): WindowInfo[] {
    const out: WindowInfo[] = [];
    for (const [id, state] of this.windows) {
      if (id === wcId) continue;
      out.push({ id, title: state.title, tabCount: this.sessions.ownedBy(id).length });
    }
    return out;
  }

  broadcast(channel: string, ...args: unknown[]): void {
    for (const state of this.windows.values()) {
      if (!state.win.isDestroyed()) state.win.webContents.send(channel, ...args);
    }
  }

  /** The renderer asks to close (it has no tabs left); skip the confirm if nothing is live. */
  closeFromRenderer(wcId: number): void {
    const state = this.windows.get(wcId);
    if (!state) return;
    if (this.sessions.liveCountFor(wcId) === 0) state.forceClose = true;
    state.win.close();
  }

  trackMove(sessionId: string, targetWc: number): void {
    this.pendingMoves.set(sessionId, targetWc);
  }

  clearMove(sessionId: string): void {
    this.pendingMoves.delete(sessionId);
  }

  private rememberBounds(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.saved = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    void this.stateStore.set(this.saved);
  }

  private onClose(state: WindowState, e: Electron.Event): void {
    if (state.forceClose) return;
    const live = this.sessions.liveCountFor(state.win.webContents.id);
    if (live === 0) return;
    const choice = dialog.showMessageBoxSync(state.win, {
      type: 'question',
      buttons: ['Close', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `${live} live connection${live === 1 ? '' : 's'} will be terminated.`,
    });
    if (choice !== 0) e.preventDefault();
  }

  private onClosed(wcId: number): void {
    this.windows.delete(wcId);
    this.sessions.dropOwner(wcId);

    // A session that was travelling *to* this window is stranded: hand it back or end it.
    for (const [sessionId, target] of [...this.pendingMoves]) {
      if (target !== wcId) continue;
      this.pendingMoves.delete(sessionId);
      const orphan = this.sessions.orphans().find((o) => o.sessionId === sessionId);
      const prev = orphan ? this.windows.get(orphan.prevOwnerWc) : undefined;
      const info = this.sessions.get(sessionId);
      if (orphan && prev && info && !prev.win.isDestroyed()) {
        const adoption: Adoption = { sessionId, title: info.title, serialized: '', alive: info.alive, exitCode: info.exitCode };
        prev.win.webContents.send('session:adopt', adoption);
        prev.win.focus();
      } else {
        this.sessions.close(sessionId);
      }
    }
  }
}
