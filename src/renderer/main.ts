import type { Adoption, QuickTarget, SessionProfile } from '../shared/types';
import { isLocalProcessTitle } from '../shared/titles';
import { ProfileForm } from './profile-form';
import { SettingsForm } from './settings-form';
import { describeTarget, Sidebar } from './sidebar';
import { TabBar, type Tab } from './tabs';
import { matchShortcut, TerminalView, type Shortcut } from './terminal-view';

const api = window.sshit;

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

  const profileForm = new ProfileForm($('#profile-dialog'), api.browseForFile);
  const settingsForm = new SettingsForm($('#settings-dialog'), api.browseForFile);

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
    });
    tab = tabs.add(title, view);
    return tab;
  }

  function bindSession(tab: Tab, sessionId: string, title?: string): void {
    tab.sessionId = sessionId;
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
      const { sessionId, title } = await api.openSession(profile.id, tab.view.cols, tab.view.rows);
      bindSession(tab, sessionId, title);
    } catch (err) {
      failTab(tab, err, false);
    }
  }

  async function quickConnect(target: QuickTarget): Promise<void> {
    const tab = newTab(describeTarget(target));
    try {
      const { sessionId, title } = await api.openQuickSession(target, tab.view.cols, tab.view.rows);
      bindSession(tab, sessionId, title);
    } catch (err) {
      failTab(tab, err, false);
    }
  }

  async function reconnect(tab: Tab): Promise<void> {
    if (!tab.sessionId) return;
    tab.view.revive();
    try {
      const { sessionId } = await api.reconnectSession(tab.sessionId, tab.view.cols, tab.view.rows);
      tabs.setAlive(tab, true);
      bindSession(tab, sessionId);
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

  api.onTabCommand((sessionId, cmd) => {
    const tab = tabs.bySession(sessionId);
    if (!tab) return;
    switch (cmd.kind) {
      case 'close':
        void closeTab(tab);
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
  if (tabs.count === 0) sidebar.focusFilter();
}

void boot();
