import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('omniclip', {
  join: (code: string): Promise<boolean> => ipcRenderer.invoke('omniclip:join', code),
});
