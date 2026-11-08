import type { Adoption, QuickTarget, SessionProfile, UpdateNotice } from '../shared/types';
import { isLocalProcessTitle } from '../shared/titles';
import { ProfileForm } from './profile-form';
import { SettingsForm } from './settings-form';
import { describeTarget, Sidebar } from './sidebar';
import { TabBar, type Tab } from './tabs';
import { matchShortcut, TerminalView, type Shortcut } from './terminal-view';
import { askForFolder, Toasts } from './transfer-ui';

const api = window.otherssh;

function $<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Missing ${selector}`);
  return el;
}

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

async function boot(): Promise<void> {
  const init = await api.getWindowInitState();
  let settings = init.settings;
  if (init.tornOff) document.body.classList.add('sidebar-collapsed');

  /** Output that arrived before the tab learned its session id (open() reply still in flight). */
  const pendingData = new Map<string, string[]>();

  const tabs = new TabBar($('#tabs'), $('#terminals'), $('#empty'), {
    onActivate: (tab) => api.setWindowTitle(tab?.title ?? ''),
    onCloseClick: (tab) => void closeTab(tab),
    onContextMenu: (tab) => {
      if (tab.sessionId) api.showTabContextMenu(tab.sessionId);
    },
  });

  const sidebar = new Sidebar(
    {
      list: $('#profiles'),
      filter: $('#filter'),
      connect: $('#btn-connect'),
      add: $('#btn-new'),
      edit: $('#btn-edit'),
      remove: $('#btn-delete'),
      importBtn: $('#btn-import'),
      settings: $('#btn-settings'),
    },
    {
      onConnect: (p) => void connect(p),
      onQuickConnect: (t) => void quickConnect(t),
      onNew: () => void editProfile(),
      onEdit: (p) => void editProfile(p),
      onDelete: (p) => void deleteProfile(p),
      onContextMenu: (p) => api.showProfileContextMenu(p.id),
      onImport: () => void importSshConfig(),
      onSettings: () => void openSettings(),
    },
  );
  sidebar.setProfiles(init.profiles);

  const toasts = new Toasts($('#toasts'));
  const profileForm = new ProfileForm($('#profile-dialog'), api.browseForFile);
  const settingsForm = new SettingsForm($('#settings-dialog'), api.browseForFile, {
    status: () => api.getUpdateStatus(),
    check: () => api.checkForUpdates(),
    install: () => api.installUpdate(),
    onStatus: (cb) => api.onUpdateStatus(cb),
  });

  // ---- tabs and sessions -----------------------------------------------------

  function newTab(title: string): Tab {
    let tab!: Tab;
    const view = new TerminalView(settings, init.windowsBuildNumber, {
      onInput: (data) => {
        // These fire from xterm during tabs.add() before `tab` is assigned, so guard with ?.
        if (tab?.sessionId && tab.alive) api.writeSession(tab.sessionId, data);
      },
      onResize: (cols, rows) => {
        if (tab?.sessionId && tab.alive) api.resizeSession(tab.sessionId, cols, rows);
      },
      onTitle: (title) => {
        // ConPTY first reports the local exe path as the title; keep the session name until the remote shell speaks.
        if (title && tab && !isLocalProcessTitle(title)) tabs.setTitle(tab, title);
      },
      onShortcut: handleShortcut,
      onCloseRequest: () => void closeTab(tab),
      onReconnectRequest: () => void reconnect(tab),
      readClipboard: () => api.readClipboard(),
      writeClipboard: (text) => api.writeClipboard(text),
      openExternal: (url) => api.openExternal(url),
      onDropFiles: (files) => void handleDrop(tab, files),
    });
    tab = tabs.add(title, view);
    return tab;
  }

  function bindSession(tab: Tab, sessionId: string, cwdToken: string, title?: string): void {
    tab.sessionId = sessionId;
    tab.view.cwd.setToken(cwdToken);
    tab.el.dataset['sessionId'] = sessionId;
    if (title) tabs.setTitle(tab, title);
    const queued = pendingData.get(sessionId);
    if (queued) {
      pendingData.delete(sessionId);
      for (const chunk of queued) tab.view.write(chunk);
    }
  }

  function failTab(tab: Tab, err: unknown, canReconnect: boolean): void {
    tab.view.write(`\r\n\x1b[31m${errorMessage(err)}\x1b[0m\r\n`);
    tabs.setAlive(tab, false);
    tab.view.markDead(undefined, canReconnect);
  }

  async function connect(profile: SessionProfile): Promise<void> {
    const tab = newTab(profile.name);
    try {
      const { sessionId, title, cwdToken } = await api.openSession(profile.id, tab.view.cols, tab.view.rows);
      bindSession(tab, sessionId, cwdToken, title);
    } catch (err) {
      failTab(tab, err, false);
    }
  }

  async function quickConnect(target: QuickTarget): Promise<void> {
    const tab = newTab(describeTarget(target));
    try {
      const { sessionId, title, cwdToken } = await api.openQuickSession(target, tab.view.cols, tab.view.rows);
      bindSession(tab, sessionId, cwdToken, title);
    } catch (err) {
      failTab(tab, err, false);
    }
  }

  async function reconnect(tab: Tab): Promise<void> {
    if (!tab.sessionId) return;
    tab.view.revive();
    try {
      const { sessionId, cwdToken } = await api.reconnectSession(tab.sessionId, tab.view.cols, tab.view.rows);
      tabs.setAlive(tab, true);
      bindSession(tab, sessionId, cwdToken);
    } catch (err) {
      failTab(tab, err, true);
    }
  }

  async function closeTab(tab: Tab): Promise<void> {
    if (tab.alive && tab.sessionId) {
      const ok = await api.confirm(`Close "${tab.title}"? The connection will be terminated.`);
      if (!ok) {
        tab.view.focus();
        return;
      }
    }
    const sessionId = tab.sessionId;
    tab.sessionId = null;
    tabs.remove(tab);
    if (sessionId) void api.closeSession(sessionId).catch(() => undefined);
    if (tabs.count === 0 && init.tornOff) api.closeWindow();
  }

  async function moveTab(tab: Tab, target: { kind: 'new' } | { kind: 'window'; windowId: number }): Promise<void> {
    const sessionId = tab.sessionId;
    if (!sessionId) return;
    let detached = false;
    try {
      await api.detachSession(sessionId);
      detached = true;
      const serialized = await tab.view.serialize(settings.scrollback);
      if (target.kind === 'new') await api.moveSessionToNewWindow(sessionId, serialized);
      else await api.moveSessionToWindow(sessionId, target.windowId, serialized);
    } catch (err) {
      tab.view.write(`\r\n\x1b[31mMove failed: ${errorMessage(err)}\x1b[0m\r\n`);
      if (detached) await api.attachSession(sessionId, tab.view.cols, tab.view.rows).catch(() => undefined);
      return;
    }
    tab.sessionId = null;
    tabs.remove(tab);
    if (tabs.count === 0) api.closeWindow();
  }

  function adopt(adoption: Adoption): void {
    const tab = newTab(adoption.title);
    tab.sessionId = adoption.sessionId;
    tab.el.dataset['sessionId'] = adoption.sessionId;
    tab.view.cwd.setToken(adoption.cwdToken);
    tab.view.write(adoption.serialized, () => {
      tab.view.fitNow();
      api
        .attachSession(adoption.sessionId, tab.view.cols, tab.view.rows)
        .then((result) => {
          if (!result.alive) {
            tabs.setAlive(tab, false);
            tab.view.markDead(result.exitCode, true);
          }
        })
        .catch((err) => failTab(tab, err, false));
    });
  }

  // ---- drag-and-drop uploads -------------------------------------------------

  const stillLive = (tab: Tab, sessionId: string): boolean => tab.sessionId === sessionId && tab.alive;

  async function handleDrop(tab: Tab, files: File[]): Promise<void> {
    if (!tab.sessionId || !tab.alive) return;
    const paths = files.map((f) => api.pathForFile(f)).filter(Boolean);
    if (paths.length === 0) return;
    const what = paths.length === 1 ? `"${paths[0]!.split(/[\\/]/).pop()}"` : `${paths.length} items`;

    // Straight there when the shell told us where it is; otherwise check with a prefilled guess.
    const guess = tab.view.cwd.current;
    let dir = guess.path;
    if (!guess.sure) {
      const picked = await askForFolder(tab.view.element, {
        what,
        path: guess.path,
        canTeach: !tab.view.cwd.taught,
        onTeach: () => void teach(tab),
      });
      tab.view.focus();
      if (picked === null) return;
      dir = picked;
    }
    await upload(tab, paths, what, dir);
  }

  async function upload(tab: Tab, paths: string[], what: string, dir: string): Promise<void> {
    const sessionId = tab.sessionId;
    if (!sessionId) return;
    const toast = toasts.show(`Uploading ${what} to ${dir}…`, 'busy');
    try {
      const result = await api.uploadFiles(sessionId, paths, dir);
      if (result.kind === 'done') {
        toast.update(`Sent ${what} to ${dir}`, 'ok');
        return;
      }
      const typeIt = (): void => {
        if (stillLive(tab, sessionId)) tab.view.paste(result.command);
      };
      const parked = `${dir} needs sudo, so ${what} is waiting in your home folder.`;
      if (tab.view.cwd.current.sure) {
        // At a prompt: put the sudo mv on the command line, unsent, for them to check and run.
        typeIt();
        toast.update(`${parked} Press Enter in the terminal to move it.`, 'info');
      } else {
        // Something else may have the terminal (vim, a REPL), so let them choose when to type it.
        toast.update(parked, 'info', [
          { label: 'Type the sudo command', run: typeIt },
          { label: 'Copy it', run: () => api.writeClipboard(result.command) },
        ]);
      }
    } catch (err) {
      toast.update(`Upload failed: ${errorMessage(err)}`, 'error');
    }
  }

  async function teach(tab: Tab): Promise<void> {
    const sessionId = tab.sessionId;
    if (!sessionId || !tab.alive) return;
    const toast = toasts.show(`Teaching ${tab.title} to report its folder…`, 'busy');
    // Leading space keeps it out of bash history on the usual HISTCONTROL settings.
    const reload = {
      label: 'Load it in this shell',
      run: () => {
        if (stillLive(tab, sessionId)) api.writeSession(sessionId, ' source ~/.bashrc\r');
        tab.view.focus();
      },
    };
    try {
      const result = await api.teachServer(sessionId);
      switch (result.kind) {
        case 'done':
          toast.update('Done. New shells on this server report their folder, so drops go straight there.', 'info', [reload]);
          break;
        case 'already':
          toast.update('This server is already set up. A shell started before that needs reloading.', 'info', [reload]);
          break;
        case 'unsupported':
          toast.update(`Your login shell there is ${result.shell}; only bash can be set up automatically for now.`, 'error');
          break;
      }
    } catch (err) {
      toast.update(`Couldn't set it up: ${errorMessage(err)}`, 'error');
    }
  }

  // ---- updates ---------------------------------------------------------------

  const restartToUpdate = (): void => {
    api.installUpdate().catch((err) => toasts.show(`Couldn't install the update: ${errorMessage(err)}`, 'error'));
  };

  function showUpdateNotice(notice: UpdateNotice): void {
    switch (notice.kind) {
      case 'ready':
        toasts.show(`OtherSSH ${notice.version} is ready to install.`, 'info', [{ label: 'Restart to update', run: restartToUpdate }]);
        break;
      case 'nudge':
        // Showing it already put the next one off three days, so "Later" only has to close it.
        toasts.show('An OtherSSH update is ready. Restart now to finish installing it.', 'info', [
          { label: 'Restart now', run: restartToUpdate },
          { label: 'Later', run: () => undefined },
        ]);
        break;
      case 'updated': {
        const notes = notice.notes?.trim();
        toasts.show(`OtherSSH was updated to ${notice.version}.${notes ? ` ${notes}` : ''}`, 'info');
        break;
      }
      case 'message':
        toasts.show(notice.text, notice.tone);
        break;
    }
  }

  // An update never installs over an open dialog or the upload question, which may hold unsaved input.
  let modalOpen = false;
  new MutationObserver(() => {
    const open = document.querySelector('dialog[open], .drop-bar') !== null;
    if (open !== modalOpen) api.reportModal((modalOpen = open));
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });

  // ---- sidebar actions -------------------------------------------------------

  async function editProfile(existing?: SessionProfile): Promise<void> {
    const result = await profileForm.open(existing, sidebar.groupNames());
    if (!result) return;
    try {
      const saved = await api.saveProfile(result.profile);
      if (result.connect) void connect(saved);
    } catch (err) {
      window.alert(errorMessage(err));
    }
  }

  async function deleteProfile(profile: SessionProfile): Promise<void> {
    if (await api.confirm(`Delete "${profile.name}"?`)) await api.deleteProfile(profile.id);
  }

  async function importSshConfig(): Promise<void> {
    const aliases = await api.listImportableHosts();
    if (aliases.length === 0) {
      await api.info('Nothing new to import: every Host alias in ~/.ssh/config already has a session.');
      return;
    }
    const noun = aliases.length === 1 ? 'host' : 'hosts';
    if (await api.confirm(`Import ${aliases.length} ${noun} from ~/.ssh/config?\n\n${aliases.join(', ')}`)) {
      await api.importSshConfig();
    }
  }

  async function openSettings(): Promise<void> {
    const resolved = await api.resolveSshPath();
    const patch = await settingsForm.open(settings, resolved);
    if (patch) settings = await api.setSettings(patch);
  }

  // ---- shortcuts and layout --------------------------------------------------

  function setSidebarVisible(visible: boolean): void {
    document.body.classList.toggle('sidebar-collapsed', !visible);
    tabs.current?.view.fitNow();
  }

  function handleShortcut(shortcut: Shortcut): void {
    switch (shortcut) {
      case 'nextTab':
        tabs.cycle(1);
        break;
      case 'prevTab':
        tabs.cycle(-1);
        break;
      case 'closeTab':
        if (tabs.current) void closeTab(tabs.current);
        break;
      case 'newTab':
        setSidebarVisible(true);
        sidebar.focusFilter();
        break;
      case 'toggleSidebar':
        setSidebarVisible(document.body.classList.contains('sidebar-collapsed'));
        tabs.current?.view.focus();
        break;
    }
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented) return;
    const shortcut = matchShortcut(ev);
    if (shortcut) {
      ev.preventDefault();
      handleShortcut(shortcut);
    }
  });

  $('#btn-sidebar').addEventListener('click', () => handleShortcut('toggleSidebar'));

  let resizeTimer: number | undefined;
  new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => tabs.current?.view.fitNow(), 50);
  }).observe($('#terminals'));

  // ---- events from main ------------------------------------------------------

  api.onSessionData((sessionId, chunk) => {
    const tab = tabs.bySession(sessionId);
    if (tab) {
      tab.view.write(chunk);
      if (tab !== tabs.current && tab.alive) tabs.setActivity(tab, true);
      return;
    }
    const queue = pendingData.get(sessionId) ?? [];
    queue.push(chunk);
    pendingData.set(sessionId, queue);
  });

  api.onSessionExit((sessionId, exitCode) => {
    const tab = tabs.bySession(sessionId);
    if (!tab) return;
    tabs.setAlive(tab, false);
    tab.view.markDead(exitCode, true);
  });

  api.onAdoptSession(adopt);
  api.onUpdateNotice(showUpdateNotice);

  api.onTabCommand((sessionId, cmd) => {
    const tab = tabs.bySession(sessionId);
    if (!tab) return;
    switch (cmd.kind) {
      case 'close':
        void closeTab(tab);
        break;
      case 'teach':
        void teach(tab);
        break;
      case 'moveToNewWindow':
        void moveTab(tab, { kind: 'new' });
        break;
      case 'moveToWindow':
        void moveTab(tab, { kind: 'window', windowId: cmd.windowId });
        break;
    }
  });

  api.onProfileCommand((profileId, cmd) => {
    const profile = sidebar.get(profileId);
    if (!profile) return;
    switch (cmd) {
      case 'connect':
        void connect(profile);
        break;
      case 'edit':
        void editProfile(profile);
        break;
      case 'duplicate':
        void editProfile({ ...profile, id: '', name: `${profile.name} (copy)` });
        break;
      case 'delete':
        void deleteProfile(profile);
        break;
    }
  });

  api.onProfilesChanged((list) => sidebar.setProfiles(list));

  api.onSettingsChanged((next) => {
    settings = next;
    for (const tab of tabs.all()) tab.view.applySettings(next);
  });

  // ---- go --------------------------------------------------------------------

  for (const adoption of init.adoptions) adopt(adoption);
  for (const notice of init.updateNotices) showUpdateNotice(notice);
  if (tabs.count === 0) sidebar.focusFilter();
}

void boot();
