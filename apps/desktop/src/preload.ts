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
    sendTo: (id: string) => ipcRenderer.invoke('settings:sendTo', id),
    sendClipboardTo: (deviceId: string) => ipcRenderer.invoke('settings:sendClipboardTo', deviceId),
    ignoreApp: (name: string, ignore: boolean) => ipcRenderer.invoke('settings:ignoreApp', name, ignore),
    saveSnippet: (id: string | null, snippet: { name: string; keyword?: string; text: string }) => ipcRenderer.invoke('settings:saveSnippet', id, snippet),
    deleteSnippet: (id: string) => ipcRenderer.invoke('settings:deleteSnippet', id),
    sendText: (text: string, deviceId?: string) => ipcRenderer.invoke('settings:sendText', text, deviceId),
    setRelay: (url: string) => ipcRenderer.invoke('settings:setRelay', url),
    onChange: (fn: () => void) => {
      ipcRenderer.on('settings:changed', fn);
    },
  },
  picker: {
    list: (query: string) => ipcRenderer.invoke('picker:list', query),
    choose: (id: string) => ipcRenderer.invoke('picker:choose', id),
    close: () => ipcRenderer.invoke('picker:close'),
    onShow: (fn: () => void) => {
      ipcRenderer.on('picker:show', fn);
    },
  },
});
