import { ipcMain, shell, dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/ipc';
import type { AccountView } from '../../shared/accounts';
import type { AccountSessionManager } from './AccountSessionManager';
import { AccountApi, ACCOUNT_ORIGIN } from './AccountApi';
import type { UpdateManager } from '../updates/UpdateManager';
import {googleAccountLogin} from './GoogleAccountLogin';
import type {AccountContextManager} from './AccountContextManager';
import {contextKind} from '../../shared/accountContext';
import {DOCUMENT_EXTENSIONS} from '../documents/DocumentProcessor';
import type {AccountCreditsManager} from './AccountCreditsManager';

/** Separate account boundary: no generic relay, token, URL or filesystem IPC. */
export function registerAccountIpc(window: BrowserWindow, account?: AccountSessionManager,
  options?: { workspaceUserId?: string; stop(): Promise<void>; restart(): void; updates: UpdateManager; context?:AccountContextManager; credits?:AccountCreditsManager }): void {
  const trusted = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized desktop request.');
  };
  const requireAccount = (): AccountSessionManager => { if (!account || !options) throw new Error('Account mode is unavailable in this build.'); return account; };
  const safeView = (view: AccountView): AccountView => view.state === 'active' && view.userId !== options?.workspaceUserId
    ? { mode: 'cluera-staging', state: 'checking', message: 'Opening your isolated account workspace…' } : view;
  const complete = (view: AccountView): AccountView => {
    if (view.state === 'active' && view.userId !== options?.workspaceUserId) options?.restart();
    return safeView(view);
  };
  ipcMain.handle('account:status', event => { trusted(event); return account ? safeView(account.status()) : { mode: 'legacy', state: 'signed-out' }; });
  ipcMain.handle('account:auth-options', async event => {
    trusted(event); requireAccount();
    try { return await new AccountApi().authOptions(); }
    catch { return { google: 'unavailable' }; }
  });
  ipcMain.handle('account:login', async (event, input: unknown) => {
    trusted(event); const owner = requireAccount();
    const parsed = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) }).strict().safeParse(input);
    if (!parsed.success) throw new Error('Enter a valid email and password.');
    return complete(await owner.login(parsed.data));
  });
  ipcMain.handle('account:retry', async event => { trusted(event); return complete(await requireAccount().restore()); });
  ipcMain.handle('account:google',async event=>{trusted(event);return complete(await requireAccount().loginExternal(signal=>googleAccountLogin(url=>shell.openExternal(url),signal)));});
  ipcMain.handle('account:logout', async (event, allDevices: unknown) => {
    trusted(event); const owner = requireAccount();
    if (typeof allDevices !== 'boolean') throw new Error('Invalid sign-out request.');
    const ending = owner.logout(allDevices); await options!.stop(); return ending;
  });
  ipcMain.handle('account:open-web', async (event, action: unknown) => {
    trusted(event); requireAccount();
    if (!['signup','reset-password','dashboard','credits'].includes(action as string)) throw new Error('Unsupported account action.');
    // Browser BFF owns email confirmation/recovery; no tokens cross the browser handoff.
    if(action==='credits'){
      const state=requireAccount().status();
      if(state.state!=='active'||state.userId!==options?.workspaceUserId||!z.string().uuid().safeParse(state.userId).success)throw new Error('Sign in to your account to continue.');
      // UUID is a non-secret owner hint, never authentication. Browser must
      // independently sign in and match; tokens are never transferred.
      await shell.openExternal(`${ACCOUNT_ORIGIN}/account/checkout?desktopAccount=${state.userId}`);
    }else await shell.openExternal(`${ACCOUNT_ORIGIN}/account${action==='signup'?'#signup':action==='reset-password'?'#forgot-password':''}`);
  });
  if (!account || !options) return;
  const requireAccess = (checkUpdatePolicy=true) => {
    const state = account.status();
    if (state.state !== 'active' || state.userId !== options.workspaceUserId) throw new Error('Sign in to your account to continue.');
    if(checkUpdatePolicy)options.updates.assertSupported();
  };
  const context=()=>{requireAccess();if(!options.context)throw new Error('Account context is unavailable.');return options.context;};
  ipcMain.handle('account:credits',event=>{trusted(event);requireAccess(false);if(!options.credits)throw new Error('Account reporting is unavailable.');return options.credits.refresh();});
  ipcMain.handle('account:context-list',event=>{trusted(event);return context().list();});
  ipcMain.handle('account:context-select',(event,input:unknown)=>{trusted(event);return context().select(input);});
  ipcMain.handle('account:context-read',(event,id:unknown)=>{trusted(event);return context().read(z.string().uuid().parse(id));});
  ipcMain.handle('account:context-change',(event,input:unknown)=>{trusted(event);return context().change(input);});
  ipcMain.handle('account:context-retry',event=>{trusted(event);return context().retry();});
  ipcMain.handle('account:context-import',async(event,kind:unknown)=>{trusted(event);const manager=context(),category=contextKind.parse(kind);
    const result=await dialog.showOpenDialog(window,{properties:['openFile'],filters:[{name:'Account documents',extensions:DOCUMENT_EXTENSIONS}]});
    if(result.canceled||result.filePaths.length!==1)return null;
    requireAccess();return manager.importFile(result.filePaths[0],category);
  });
  ipcMain.handle(IPC.providers.status, event => { trusted(event); requireAccess(); return { providerMode:'managed',
    gemini:{provider:'gemini',configured:true},deepgram:{provider:'deepgram',configured:true} }; });
  ipcMain.handle(IPC.updates.status, event => { trusted(event); return options.updates.getStatus(); });
  ipcMain.handle(IPC.updates.check, event => { trusted(event); return options.updates.check(); });
  ipcMain.handle(IPC.updates.install, async event => { trusted(event); requireAccess(false); await account.authorizeWork(); return options.updates.install(); });
  ipcMain.handle(IPC.updates.cancel, event => { trusted(event); options.updates.cancelInstall(); });
  ipcMain.handle(IPC.updates.openDownload, async event => { trusted(event); await shell.openExternal(options.updates.officialDownloadPage()); });
}
