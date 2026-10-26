import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('omniclip', {
  join: (code: string): Promise<boolean> => ipcRenderer.invoke('omniclip:join', code),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    rename: (name: string) => ipcRenderer.invoke('settings:rename', name),
    chooseDownloadDir: () => ipcRenderer.invoke('settings:chooseDownloadDir'),
    openDownloadDir: () => ipcRenderer.invoke('settings:openDownloadDir'),
    removeDevice: (id: string) => ipcRenderer.invoke('settings:removeDevice', id),
    search: (query: string) => ipcRenderer.invoke('settings:search', query),
    pin: (id: string, pinned: boolean) => ipcRenderer.invoke('settings:pin', id, pinned),
    copy: (id: string) => ipcRenderer.invoke('settings:copy', id),
    pair: () => ipcRenderer.invoke('settings:pair'),
    checkUpdates: () => ipcRenderer.invoke('settings:checkUpdates'),
    onChange: (fn: () => void) => {
      ipcRenderer.on('settings:changed', fn);
    },
  },
});
