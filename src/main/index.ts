import { app, Menu, webContents } from 'electron';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { registerIpc } from './ipc';
import { JsonStore } from './json-store';
import { SessionManager } from './session-manager';
import { SessionStore } from './session-store';
import { SettingsStore } from './settings';
import { resolveSshPath } from './ssh-path';
import { createLog } from './log';
import { createTransfers, type RunResult } from './transfer';
import { createAppUpdater } from './updates/electron';
import { WindowManager, type WindowStateFile } from './windows';

app.setAppUserModelId('dev.otherworld.otherssh');

// Lets automated smoke tests run against a throwaway data directory.
if (process.env['OTHERSSH_USER_DATA']) app.setPath('userData', process.env['OTHERSSH_USER_DATA']);
else migrateLegacyUserData();

// The app was called SSHIT before; carry its data over once on first launch as OtherSSH.
function migrateLegacyUserData(): void {
  const userData = app.getPath('userData');
  const legacy = join(app.getPath('appData'), 'SSHIT');
  if (existsSync(join(userData, 'sessions.json')) || !existsSync(join(legacy, 'sessions.json'))) return;
  mkdirSync(userData, { recursive: true });
  for (const file of ['sessions.json', 'settings.json', 'window-state.json']) {
    const from = join(legacy, file);
    if (existsSync(from)) copyFileSync(from, join(userData, file));
  }
}

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

    const transfers = createTransfers({ resolveSsh, exists: existsSync, run: runTool });
    const log = createLog(join(userData, 'otherssh.log'));
    const updates = createAppUpdater({ userData, settings, sessions, transfers, windows: () => windows, log });

    windows = new WindowManager(sessions, windowState, savedWindowState);
    registerIpc({ sessions, windows, profiles, settings, transfers, updates, resolveSsh });
    profiles.onChange((list) => windows?.broadcast('profiles:changed', list));
    settings.onChange((s) => windows?.broadcast('settings:changed', s));

    windows.create({ tornOff: false });
    void updates.updater.start();
  });
}

app.on('window-all-closed', () => app.quit());

/** Run scp/ssh without a console window, collecting output. Never rejects: a spawn error becomes stderr. */
function runTool(file: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { windowsHide: true, cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.on('error', () => undefined); // the tool may exit before reading it all
    child.stdin.end(input ?? '');
  });
}

/** node-pty wants a string-only env; process.env may carry undefined values. */
function definedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') out[k] = v;
  return out;
}
