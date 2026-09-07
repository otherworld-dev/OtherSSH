import { app, Menu, webContents } from 'electron';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { registerIpc } from './ipc';
import { JsonStore } from './json-store';
import { SessionManager } from './session-manager';
import { SessionStore } from './session-store';
import { SettingsStore } from './settings';
import { resolveSshPath } from './ssh-path';
import { WindowManager, type WindowStateFile } from './windows';

app.setAppUserModelId('dev.otherworld.sshit');

// Lets automated smoke tests run against a throwaway data directory.
if (process.env['SSHIT_USER_DATA']) app.setPath('userData', process.env['SSHIT_USER_DATA']);

// No application menu: every default accelerator (Ctrl+W, Ctrl+R, Ctrl+Shift+I, ...)
// would otherwise steal keystrokes from the terminal.
Menu.setApplicationMenu(null);

let windows: WindowManager | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windows?.create({ tornOff: false }));

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const profiles = new SessionStore(join(userData, 'sessions.json'));
    const settings = new SettingsStore(join(userData, 'settings.json'));
    const windowState = new JsonStore<WindowStateFile>(join(userData, 'window-state.json'));
    const [, , savedWindowState] = await Promise.all([profiles.load(), settings.load(), windowState.load({})]);

    const resolveSsh = (): string | null =>
      resolveSshPath({
        platform: process.platform,
        env: process.env,
        exists: existsSync,
        settingsPath: settings.get().sshPath,
      });

    const sessions = new SessionManager({
      spawn: (r) =>
        pty.spawn(r.file, r.args, {
          name: 'xterm-256color',
          cols: r.cols,
          rows: r.rows,
          cwd: os.homedir(),
          env: { ...definedEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        }),
      send: (wcId, channel, ...args) => {
        const target = webContents.fromId(wcId);
        if (!target || target.isDestroyed()) return false;
        target.send(channel, ...args);
        return true;
      },
    });

    windows = new WindowManager(sessions, windowState, savedWindowState);
    registerIpc({ sessions, windows, profiles, settings, resolveSsh });
    profiles.onChange((list) => windows?.broadcast('profiles:changed', list));
    settings.onChange((s) => windows?.broadcast('settings:changed', s));

    windows.create({ tornOff: false });
  });
}

app.on('window-all-closed', () => app.quit());

/** node-pty wants a string-only env; process.env may carry undefined values. */
function definedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}
