import {
  app,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import type { Adoption, ProfileCommand, QuickTarget, SessionProfile, Settings, TabCommand, WindowInitState } from '../shared/types';
import { sanitizeProfile } from '../shared/profile';
import { buildSshArgs } from './ssh-args';
import { importableHosts, parseSshConfigHosts, type SshConfigHost } from './ssh-config';
import type { SessionManager } from './session-manager';
import type { SessionStore } from './session-store';
import type { SettingsStore } from './settings';
import type { WindowManager } from './windows';

export interface IpcContext {
  sessions: SessionManager;
  windows: WindowManager;
  profiles: SessionStore;
  settings: SettingsStore;
  resolveSsh: () => string | null;
}

type AnyEvent = IpcMainEvent | IpcMainInvokeEvent;

export function registerIpc(ctx: IpcContext): void {
  const { sessions, windows, profiles, settings } = ctx;

  /** Only frames we created, and only their top-level frame, may talk to main. */
  const trusted = (event: AnyEvent): boolean => {
    if (!windows.has(event.sender.id)) return false;
    const frame = event.senderFrame;
    return !!frame && frame.frameTreeNodeId === event.sender.mainFrame.frameTreeNodeId;
  };

  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted sender');
      return fn(event, ...args);
    });
  };
  const on = (channel: string, fn: (event: IpcMainEvent, ...args: any[]) => void): void => {
    ipcMain.on(channel, (event, ...args) => {
      if (trusted(event)) fn(event, ...args);
    });
  };

  const requireOwner = (event: AnyEvent, sessionId: string): void => {
    if (sessions.ownerOf(sessionId) !== event.sender.id) throw new Error('Window does not own this session');
  };

  const adoptionFor = (sessionId: string, serialized: string): Adoption => {
    const info = sessions.get(sessionId);
    if (!info) throw new Error(`Unknown session ${sessionId}`);
    return { sessionId, title: info.title, serialized, alive: info.alive, exitCode: info.exitCode };
  };

  // ---- profiles / settings ----------------------------------------------------
  handle('profiles:list', () => profiles.list());
  handle('profiles:save', (_e, raw: unknown) => profiles.save(sanitizeProfile(raw as SessionProfile)));
  handle('profiles:delete', (_e, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Bad profile id');
    return profiles.delete(id);
  });
  handle('settings:get', () => settings.get());
  handle('settings:set', (_e, patch: unknown) => settings.update(sanitizeSettingsPatch(patch)));
  handle('ssh:resolve', () => ctx.resolveSsh());

  handle('dialog:browse', async (event, defaultPath?: unknown) => {
    const state = windows.get(event.sender.id);
    if (!state) return undefined;
    const result = await dialog.showOpenDialog(state.win, {
      defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined,
      properties: ['openFile', 'showHiddenFiles'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  handle('dialog:confirm', async (event, message: unknown) => {
    const state = windows.get(event.sender.id);
    if (!state) return false;
    const { response } = await dialog.showMessageBox(state.win, {
      type: 'question',
      buttons: ['OK', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: String(message),
    });
    return response === 0;
  });

  handle('dialog:info', async (event, message: unknown) => {
    const state = windows.get(event.sender.id);
    if (!state) return;
    await dialog.showMessageBox(state.win, { type: 'info', buttons: ['OK'], message: String(message) });
  });

  on('shell:openExternal', (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  // ---- ~/.ssh/config import ---------------------------------------------------
  const readSshConfigHosts = async (): Promise<SshConfigHost[]> => {
    try {
      return parseSshConfigHosts(await readFile(join(os.homedir(), '.ssh', 'config'), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  };

  handle('sshconfig:list', async () => importableHosts(await readSshConfigHosts(), profiles.list()).map((h) => h.alias));

  handle('sshconfig:import', async () => {
    const hosts = importableHosts(await readSshConfigHosts(), profiles.list());
    // host = alias, everything else blank: ssh reads the config itself at connect time.
    for (const h of hosts) await profiles.save({ id: '', name: h.alias, host: h.alias, group: 'ssh config' });
    return hosts.length;
  });

  on('profile:contextMenu', (event, profileId: unknown) => {
    if (typeof profileId !== 'string') return;
    const state = windows.get(event.sender.id);
    if (!state) return;
    const send = (cmd: ProfileCommand): void => {
      if (!event.sender.isDestroyed()) event.sender.send('profile:command', profileId, cmd);
    };
    Menu.buildFromTemplate([
      { label: 'Connect', click: () => send('connect') },
      { type: 'separator' },
      { label: 'Edit', click: () => send('edit') },
      { label: 'Duplicate', click: () => send('duplicate') },
      { type: 'separator' },
      { label: 'Delete', click: () => send('delete') },
    ]).popup({ window: state.win });
  });

  handle('clipboard:read', () => clipboard.readText());
  on('clipboard:write', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  // ---- sessions ---------------------------------------------------------------
  const spawnFor = (event: AnyEvent, profile: SessionProfile, cols: unknown, rows: unknown) => {
    const file = ctx.resolveSsh();
    if (!file) throw new Error('No ssh binary found. Set one in Settings.');
    return sessions.open({
      profileId: profile.id,
      title: profile.name,
      file,
      args: buildSshArgs(profile),
      cols: dim(cols, 80),
      rows: dim(rows, 24),
      ownerWc: event.sender.id,
    });
  };

  handle('session:open', (event, profileId: unknown, cols: unknown, rows: unknown) => {
    if (typeof profileId !== 'string') throw new Error('Bad profile id');
    const profile = profiles.get(profileId);
    if (!profile) throw new Error('Profile no longer exists');
    return spawnFor(event, profile, cols, rows);
  });

  handle('session:openQuick', (event, target: unknown, cols: unknown, rows: unknown) => {
    const t = (target ?? {}) as Partial<QuickTarget>;
    const profile = sanitizeProfile({ id: '', name: '', host: String(t.host ?? ''), user: t.user, port: t.port });
    return spawnFor(event, profile, cols, rows);
  });

  handle('session:reconnect', (event, sessionId: string, cols: unknown, rows: unknown) =>
    sessions.reconnect(sessionId, dim(cols, 80), dim(rows, 24), event.sender.id),
  );

  handle('session:kill', (event, sessionId: string) => {
    requireOwner(event, sessionId);
    sessions.kill(sessionId);
  });

  handle('session:close', (event, sessionId: string) => {
    requireOwner(event, sessionId);
    sessions.close(sessionId);
  });

  on('session:write', (event, sessionId: string, data: unknown) => {
    if (typeof data === 'string') sessions.write(sessionId, data, event.sender.id);
  });

  on('session:resize', (event, sessionId: string, cols: unknown, rows: unknown) => {
    sessions.resize(sessionId, dim(cols, 80), dim(rows, 24), event.sender.id);
  });

  // ---- tear-off ---------------------------------------------------------------
  handle('session:detach', (event, sessionId: string) => sessions.detach(sessionId, event.sender.id));

  handle('session:moveToNewWindow', (event, sessionId: string, serialized: unknown) => {
    const adoption = adoptionFor(sessionId, typeof serialized === 'string' ? serialized : '');
    const win = windows.create({ tornOff: true, adoptions: [adoption] });
    windows.trackMove(sessionId, win.webContents.id);
    void event;
  });

  handle('session:moveToWindow', (_event, sessionId: string, windowId: unknown, serialized: unknown) => {
    if (typeof windowId !== 'number') throw new Error('Bad window id');
    const target = windows.get(windowId);
    if (!target || target.win.isDestroyed()) throw new Error('That window is gone');
    const adoption = adoptionFor(sessionId, typeof serialized === 'string' ? serialized : '');
    windows.trackMove(sessionId, windowId);
    target.win.webContents.send('session:adopt', adoption);
    target.win.focus();
  });

  handle('session:attach', (event, sessionId: string, cols: unknown, rows: unknown) => {
    const result = sessions.attach(sessionId, dim(cols, 80), dim(rows, 24), event.sender.id);
    windows.clearMove(sessionId);
    return result;
  });

  // ---- windows ----------------------------------------------------------------
  handle('window:initState', (event): WindowInitState => ({
    windowId: event.sender.id,
    tornOff: windows.isTornOff(event.sender.id),
    adoptions: windows.takeAdoptions(event.sender.id),
    settings: settings.get(),
    profiles: profiles.list(),
    resolvedSshPath: ctx.resolveSsh(),
    windowsBuildNumber: process.platform === 'win32' ? Number(os.release().split('.')[2]) || undefined : undefined,
    isPackaged: app.isPackaged,
  }));

  handle('window:listOthers', (event) => windows.listOthers(event.sender.id));

  on('window:setTitle', (event, title: unknown) => windows.setTitle(event.sender.id, typeof title === 'string' ? title : ''));
  on('window:close', (event) => windows.closeFromRenderer(event.sender.id));

  on('tab:contextMenu', (event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') return;
    const state = windows.get(event.sender.id);
    if (!state) return;
    const others = windows.listOthers(event.sender.id);
    const send = (cmd: TabCommand): void => {
      if (!event.sender.isDestroyed()) event.sender.send('tab:command', sessionId, cmd);
    };
    const template: MenuItemConstructorOptions[] = [
      { label: 'Move to new window', click: () => send({ kind: 'moveToNewWindow' }) },
      {
        label: 'Move to window',
        enabled: others.length > 0,
        submenu: others.map((w) => ({
          label: `${w.title || 'SSHIT'} (${w.tabCount} tab${w.tabCount === 1 ? '' : 's'})`,
          click: () => send({ kind: 'moveToWindow', windowId: w.id }),
        })),
      },
      { type: 'separator' },
      { label: 'Close tab', click: () => send({ kind: 'close' }) },
    ];
    Menu.buildFromTemplate(template).popup({ window: state.win });
  });
}

function dim(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sanitizeSettingsPatch(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {};
  const p = raw as Record<string, unknown>;
  const out: Partial<Settings> = {};
  if (typeof p['sshPath'] === 'string') out.sshPath = p['sshPath'];
  if (typeof p['fontFamily'] === 'string' && p['fontFamily'].trim()) out.fontFamily = p['fontFamily'].trim();
  if (typeof p['fontSize'] === 'number' && p['fontSize'] >= 6 && p['fontSize'] <= 72) out.fontSize = Math.round(p['fontSize']);
  if (typeof p['scrollback'] === 'number' && p['scrollback'] >= 0 && p['scrollback'] <= 1_000_000) out.scrollback = Math.round(p['scrollback']);
  return out;
}
