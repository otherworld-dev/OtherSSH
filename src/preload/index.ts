import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { OtherSshApi } from '../shared/types';

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: OtherSshApi = {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  saveProfile: (profile) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resolveSshPath: () => ipcRenderer.invoke('ssh:resolve'),
  browseForFile: (defaultPath) => ipcRenderer.invoke('dialog:browse', defaultPath),
  listImportableHosts: () => ipcRenderer.invoke('sshconfig:list'),
  importSshConfig: () => ipcRenderer.invoke('sshconfig:import'),
  showProfileContextMenu: (profileId) => ipcRenderer.send('profile:contextMenu', profileId),

  openSession: (profileId, cols, rows) => ipcRenderer.invoke('session:open', profileId, cols, rows),
  openQuickSession: (target, cols, rows) => ipcRenderer.invoke('session:openQuick', target, cols, rows),
  reconnectSession: (sessionId, cols, rows) => ipcRenderer.invoke('session:reconnect', sessionId, cols, rows),
  writeSession: (sessionId, data) => ipcRenderer.send('session:write', sessionId, data),
  resizeSession: (sessionId, cols, rows) => ipcRenderer.send('session:resize', sessionId, cols, rows),
  killSession: (sessionId) => ipcRenderer.invoke('session:kill', sessionId),
  closeSession: (sessionId) => ipcRenderer.invoke('session:close', sessionId),

  pathForFile: (file) => webUtils.getPathForFile(file),
  uploadFiles: (sessionId, localPaths, remoteDir) => ipcRenderer.invoke('transfer:upload', sessionId, localPaths, remoteDir),
  teachServer: (sessionId) => ipcRenderer.invoke('transfer:teach', sessionId),

  detachSession: (sessionId) => ipcRenderer.invoke('session:detach', sessionId),
  moveSessionToNewWindow: (sessionId, serialized) => ipcRenderer.invoke('session:moveToNewWindow', sessionId, serialized),
  moveSessionToWindow: (sessionId, windowId, serialized) =>
    ipcRenderer.invoke('session:moveToWindow', sessionId, windowId, serialized),
  attachSession: (sessionId, cols, rows) => ipcRenderer.invoke('session:attach', sessionId, cols, rows),

  getWindowInitState: () => ipcRenderer.invoke('window:initState'),
  listOtherWindows: () => ipcRenderer.invoke('window:listOthers'),
  showTabContextMenu: (sessionId) => ipcRenderer.send('tab:contextMenu', sessionId),
  setWindowTitle: (title) => ipcRenderer.send('window:setTitle', title),
  closeWindow: () => ipcRenderer.send('window:close'),
  confirm: (message) => ipcRenderer.invoke('dialog:confirm', message),
  info: (message) => ipcRenderer.invoke('dialog:info', message),
  openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
  getUpdateStatus: () => ipcRenderer.invoke('updates:status'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  reportModal: (open) => ipcRenderer.send('updates:modal', open),

  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),

  onSessionData: (cb) => subscribe('session:data', cb),
  onSessionExit: (cb) => subscribe('session:exit', cb),
  onAdoptSession: (cb) => subscribe('session:adopt', cb),
  onTabCommand: (cb) => subscribe('tab:command', cb),
  onProfileCommand: (cb) => subscribe('profile:command', cb),
  onProfilesChanged: (cb) => subscribe('profiles:changed', cb),
  onSettingsChanged: (cb) => subscribe('settings:changed', cb),
  onUpdateStatus: (cb) => subscribe('updates:status', cb),
  onUpdateNotice: (cb) => subscribe('updates:notice', cb),
};

contextBridge.exposeInMainWorld('otherssh', api);
