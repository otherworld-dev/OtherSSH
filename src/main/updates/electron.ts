import { app, net, powerMonitor, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateNotice } from '../../shared/types';
import { JsonStore } from '../json-store';
import type { SessionManager } from '../session-manager';
import type { SettingsStore } from '../settings';
import type { Transfers } from '../transfer';
import type { WindowManager } from '../windows';
import { UPDATE_PUBLIC_KEY } from './public-key';
import { FEED_URL } from './rules';
import { Updater, type UpdateState } from './updater';

/** Dev builds only: a feed to test against, which may be plain http. Release builds ignore it. */
export const ENDPOINT_ENV = 'OTHERSSH_UPDATE_ENDPOINT';

export interface AppUpdater {
  updater: Updater;
  /** Notices raised before any window could show them; the first window takes them. */
  takeQueuedNotices(): UpdateNotice[];
}

/** The Updater with Electron's pieces plugged in, and the app events it listens to. */
export function createAppUpdater(o: {
  userData: string;
  settings: SettingsStore;
  sessions: SessionManager;
  transfers: Transfers;
  windows: () => WindowManager | undefined;
  log: (message: string) => void;
}): AppUpdater {
  const devFeed = app.isPackaged ? undefined : process.env[ENDPOINT_ENV]?.trim() || undefined;
  const queued: UpdateNotice[] = [];
  let anyWindowReady = false;

  const updater = new Updater({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    canInstall: app.isPackaged && process.platform === 'win32',
    feed: app.isPackaged ? FEED_URL : devFeed,
    allowHttp: devFeed !== undefined,
    publicKey: UPDATE_PUBLIC_KEY,
    store: new JsonStore<UpdateState>(join(o.userData, 'updates.json')),
    settings: () => o.settings.get(),
    fetch: (url, init) => net.fetch(url, init),
    activity: () => ({
      liveSessions: o.sessions.liveCount(),
      transfers: o.transfers.running,
      modalOpen: o.windows()?.anyModalOpen() ?? false,
    }),
    systemIdleSecs: () => powerMonitor.getSystemIdleTime(),
    launchInstaller: (name, bytes, relaunch) => {
      const dir = join(app.getPath('temp'), 'otherssh-update');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, name);
      writeFileSync(file, bytes);
      // electron-builder's NSIS installer: /S is silent, --updated keeps the user's shortcut
      // choices, --force-run starts OtherSSH again once it has installed.
      const args = ['--updated', '/S', ...(relaunch ? ['--force-run'] : [])];
      spawn(file, args, { detached: true, stdio: 'ignore' }).unref();
    },
    quitForInstall: () => {
      const windows = o.windows();
      if (windows) windows.closeAllForUpdate();
      else app.quit();
    },
    status: (status) => o.windows()?.broadcast('updates:status', status),
    notify: (notice) => {
      const target: BrowserWindow | undefined = anyWindowReady ? o.windows()?.noticeTarget() : undefined;
      if (target) target.webContents.send('updates:notice', notice);
      else queued.push(notice);
    },
    log: o.log,
  });

  powerMonitor.on('lock-screen', () => updater.sessionEvent('lock'));
  powerMonitor.on('unlock-screen', () => updater.sessionEvent('unlock'));
  powerMonitor.on('suspend', () => updater.sessionEvent('suspend'));
  powerMonitor.on('resume', () => updater.sessionEvent('resume'));
  powerMonitor.on('shutdown', () => updater.sessionEnd());
  app.on('browser-window-created', (_e, win) => win.on('session-end', () => updater.sessionEnd()));
  o.settings.onChange(() => updater.settingsChanged());

  // Installing on quit: hold the quit until the installer has been started.
  app.on('will-quit', (e) => {
    updater.stop();
    const install = updater.onQuit();
    if (!install) return;
    e.preventDefault();
    void install.finally(() => app.exit(0));
  });

  return {
    updater,
    takeQueuedNotices: () => {
      anyWindowReady = true;
      return queued.splice(0);
    },
  };
}
