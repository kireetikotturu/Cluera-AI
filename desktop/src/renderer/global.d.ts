import type { ElectronAPI } from '../shared/ipc';
import type { AccountDesktopAPI } from '../shared/accounts';

declare global {
  interface Window { electronAPI: ElectronAPI; accountAPI?: AccountDesktopAPI; }
}

export {};
