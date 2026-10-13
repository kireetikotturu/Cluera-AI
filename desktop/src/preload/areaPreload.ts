import { contextBridge, ipcRenderer } from 'electron';
import type { ShotRect, ShotSize } from '../shared/shotGeometry';

// Deliberately separate from the application bridge. The overlay cannot access
// sessions, provider keys, audio, files, or the screenshot analysis API.
contextBridge.exposeInMainWorld('areaShot', {
  submit: (rect: ShotRect, viewport: ShotSize) => ipcRenderer.invoke('area:submit', { rect, viewport }),
  cancel: () => ipcRenderer.send('area:cancel'),
});
