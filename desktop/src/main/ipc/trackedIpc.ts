import type { IpcMain } from 'electron';

type Subscription = [string, Parameters<IpcMain['on']>[1]];

/**
 * ipcMain that remembers what was registered through it, so everything can be removed again: one account's
 * workspace is closed and the next one opened in the same running app.
 */
export function trackedIpc(source: IpcMain): Pick<IpcMain, 'handle' | 'on'> & { dispose(): void } {
  const handled: string[] = [];
  const subscriptions: Subscription[] = [];
  return {
    handle(channel, listener) {
      source.handle(channel, listener);
      handled.push(channel);
    },
    on(channel, listener) {
      source.on(channel, listener);
      subscriptions.push([channel, listener]);
      return source;
    },
    dispose() {
      for (const channel of handled.splice(0)) source.removeHandler(channel);
      for (const [channel, listener] of subscriptions.splice(0)) source.removeListener(channel, listener);
    },
  };
}
