import path from 'node:path';
import fs from 'node:fs';
import { AccountSessionManager } from './accounts/AccountSessionManager';
import { AccountProviderRuntime } from './accounts/AccountProviderRuntime';
import { AccountContextManager } from './accounts/AccountContextManager';
import { AccountCreditsManager } from './accounts/AccountCreditsManager';
import { AccountPhoneSessions } from './accounts/AccountPhoneSessions';
import { AccountResumes } from './accounts/AccountResumes';
import { accountFocusCheck } from './accounts/AccountFocusCheck';
import { registerAccountIpc } from './accounts/registerAccountIpc';
import { SecureJsonStore } from './security/SecureJsonStore';
import { MANAGED_GEMINI_MODEL, MANAGED_DEEPGRAM_MODEL } from '../shared/managedProviders';
import { ACCOUNT_ORIGIN } from './accounts/AccountApi';
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  powerMonitor,
  screen,
} from 'electron';

import type { AppEventMap, AppEventName } from '../shared/types';
import type { AccountView } from '../shared/accounts';
import { IPC } from '../shared/ipc';

import { createAppConfig } from './config/appConfig';
import { Database } from './database/Database';
import { Repositories } from './database/Repositories';
import { DocumentProcessor } from './documents/DocumentProcessor';
import { LocalRetriever } from './retrieval/LocalRetriever';
import { ContextBuilder } from './context/ContextBuilder';
import { IntentDetector } from './interview/IntentDetector';
import { TurnGate } from './interview/TurnGate';
import { PromptBuilder } from './llm/PromptBuilder';
import { DemoAnswerModel } from './llm/DemoAnswerModel';
import { GeminiAnswerModel } from './llm/GeminiAnswerModel';
import { InterviewOrchestrator } from './interview/InterviewOrchestrator';
import { SessionService } from './app/SessionService';
import { FileLibraryService } from './app/FileLibraryService';
import { registerIpc } from './ipc/registerIpc';
import { trackedIpc } from './ipc/trackedIpc';
import { DemoScreenAnalyzer } from './screen/DemoScreenAnalyzer';
import { GeminiScreenAnalyzer } from './screen/GeminiScreenAnalyzer';
import { dashboardWindowBounds } from './windowLayout';
import { defaultWindowZoom, zoomBySteps } from './windowZoom';
import { ModelCatalog } from './providers/ModelCatalog';
import { UpdateManager } from './updates/UpdateManager';
import { launchWindowsInstaller, verifyWindowsPublisher } from './updates/WindowsInstaller';
import { developmentRendererUrl } from './rendererLocation';
import { packagedAccountDistribution } from './config/accountDistribution';
import { ACCOUNT_DISTRIBUTION } from '../shared/accountDistribution';
import { registerWindowVisibilityShortcut } from './windowVisibilityShortcut';
import { installTaskbarInvariant } from './windowTaskbar';

// Run before app ready: packaged installs must never reuse a developer profile
// or read a .env from the installer's/current working directory.
const accountPackage = packagedAccountDistribution(app.getAppPath(), app.isPackaged);
if (app.isPackaged && !accountPackage) throw new Error('Invalid Cluera distribution identity.');
const accountProfile = path.join(app.getPath('appData'), ACCOUNT_DISTRIBUTION.profile);
{
  app.setName(ACCOUNT_DISTRIBUTION.productName); app.setAppUserModelId(ACCOUNT_DISTRIBUTION.appId);
  fs.mkdirSync(path.join(accountProfile, 'chromium'), { recursive: true });
  app.setPath('userData', accountProfile);
  app.setPath('sessionData', path.join(accountProfile, 'chromium'));
}
// One packaged profile owner prevents a second process from keeping a session
// alive while the first process installs an update or cleans its download.
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();

let mainWindow: BrowserWindow | null = null;
let database: Database | null = null;
let unregisterWindowVisibilityShortcut = (): void => {};

/** What the page shows (a loading screen) while the app opens an account. */
const loadingView = (message: string): AccountView => ({ mode: 'cluera-staging', state: 'checking', loading: true, message });

/** The services of one signed-in account (or of the signed-out state). */
interface AccountWorkspace {
  /** Ends its live work and removes everything it registered, so another workspace can open in the same window. */
  close(): Promise<void>;
  /** The window is going away: stop provider and listening work. */
  shutdown(): void;
}

async function createWindow(): Promise<void> {
  // Whatever ends the live work of the open workspace; replaced when a workspace opens.
  let stopAccountWork: () => Promise<void> = async () => undefined;
  let workspaceUserId: string | undefined;
  /** The open account workspace; undefined while the app is opening one. */
  let workspace: AccountWorkspace | undefined;
  /** While the app opens an account (at start, or after signing in) the page shows a loading screen. */
  let opening: AccountView | undefined = loadingView('Opening Cluera AI…');
  let accountWasActive = false;
  let accountCredits:AccountCreditsManager|undefined;
  let openWhenChanged: () => void = () => undefined;
  const pageView = (view: AccountView): AccountView => opening ?? (view.state === 'active' && view.userId !== workspaceUserId
    ? loadingView('Opening your workspace…') : view);
  const account = new AccountSessionManager(
    new SecureJsonStore(path.join(accountProfile, 'secure-account-session.bin')), undefined, next => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:state', pageView(next));
      if (accountWasActive && next.state !== 'active') void stopAccountWork();
      accountWasActive = next.state === 'active';
      accountCredits?.ownerChanged();
      // Signed in (or back online) as another account than the open workspace: open that account's workspace.
      if (next.state === 'active' && next.userId !== workspaceUserId) openWhenChanged();
    });
  accountCredits=new AccountCreditsManager(account,undefined,view=>{
    if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('account:credits-state',view);
  });

const initialWindowBounds = dashboardWindowBounds(screen.getPrimaryDisplay().workArea);

mainWindow = new BrowserWindow({
  ...initialWindowBounds,
  minWidth: 420,
  minHeight: 360,
  frame: false,
  titleBarStyle: 'hidden',
  minimizable: false,
  resizable: true,
  alwaysOnTop: true,
  transparent: true,
  backgroundColor: '#00000000',
  hasShadow: false,
  show: false,

  skipTaskbar: true,

    webPreferences: {
    zoomFactor: zoomBySteps(defaultWindowZoom(initialWindowBounds), 'in', 3),
    preload: path.join(__dirname, '../preload/preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
      // Native hiding must not throttle live audio/UI scheduling in Chromium.
      backgroundThrottling: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
});

const window = mainWindow;
installTaskbarInvariant(window);
Menu.setApplicationMenu(null);
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', (event) => event.preventDefault());
window.webContents.on('before-input-event', (event, input) => {
  if (!app.isPackaged || input.type !== 'keyDown') return;
  const key = input.key.toLowerCase();
  if (key === 'f12' || ((input.control || input.meta) && input.shift && (key === 'i' || key === 'j' || key === 'c'))) {
    event.preventDefault();
  }
});

const keepWindowPinned = (): void => {
  if (!window.isDestroyed()) window.setAlwaysOnTop(true, 'screen-saver', 1);
};
keepWindowPinned();
window.on('always-on-top-changed', (_event, enabled) => {
  if (!enabled) setImmediate(keepWindowPinned);
});

if (process.platform === 'win32') {
  window.setContentProtection(true);

  console.info('Window content protection enabled');
  console.info('isContentProtected:', window.isContentProtected());
  console.info('Taskbar visibility disabled');
}

  // Zoom is controlled explicitly from the live More menu. Suppress Chromium's
  // conventional key gestures so Ctrl/Cmd +/- cannot change the session layout.
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return;
    if (['+', '=', 'add', '-', '_', 'subtract', '0', 'num0'].includes(input.key.toLowerCase())) event.preventDefault();
  });

  window.webContents.on('zoom-changed', (event) => {
    const bounds = window.getBounds();
    if (bounds.width > 80 || bounds.height > 80) return;
    event.preventDefault();
    window.webContents.setZoomFactor(1);
  });

  // ============================================================
  // EXISTING PRELOAD BRIDGE
  // ============================================================

  let preloadReady = false;

  ipcMain.once(
    'app:preload-ready',
    () => {
      preloadReady = true;

      console.info(
        'Sandboxed preload bridge ready.',
      );
    },
  );

  const emit = <K extends AppEventName>(
    name: K,
    payload: AppEventMap[K],
  ): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(
        IPC.events,
        name,
        payload,
      );
    }
  };

  const sendAccount = (): void => {
    if (!window.isDestroyed()) window.webContents.send('account:state', pageView(account.status()));
  };

  // While an account opens, only the loading screen talks to the app: its state and the close button.
  const loadingIpc = trackedIpc(ipcMain);
  const fromPage = (event: Electron.IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized desktop request.');
  };
  const answerWhileOpening = (): void => {
    loadingIpc.handle('account:status', event => { fromPage(event); return pageView(account.status()); });
    loadingIpc.handle(IPC.app.close, event => { fromPage(event); window.close(); });
  };
  answerWhileOpening();

  // ============================================================
  // ACCOUNT WORKSPACE
  // ============================================================

  /** Everything that belongs to one account: its local database and files, and the services that use them. */
  const openWorkspace = async (userId: string | undefined): Promise<AccountWorkspace> => {
    workspaceUserId = userId;
    // No legacy import and no cross-account database/file-library reuse.
    const folder = path.join(accountProfile, 'accounts', userId ?? 'signed-out');
    fs.mkdirSync(folder, { recursive: true }); app.setPath('userData', folder);
    const config = createAppConfig();
    if (accountPackage && config.licensing.serverUrl !== ACCOUNT_DISTRIBUTION.apiOrigin) throw new Error('Account API trust does not match this distribution.');
    config.databasePath = path.join(app.getPath('userData'), ACCOUNT_DISTRIBUTION.database);
    config.licensing.enforced = false; // Account authorization never falls back to license keys.

    const updates = new UpdateManager({
      enforced: config.isProduction,
      serverUrl: ACCOUNT_DISTRIBUTION.apiOrigin,
      publicKeyPem: config.licensing.publicKeyPem,
      trustedInstallerOrigins: config.licensing.trustedInstallerOrigins ?? [],
      appVersion: app.getVersion(),
      userDataPath: app.getPath('userData'),
      channel: ACCOUNT_DISTRIBUTION.channel,
      redirectOrigins: config.licensing.trustedInstallerRedirectOrigins,
      requirePublisherVerification: Boolean(config.licensing.updatePublisher),
      installer: {
        supported: () => app.isPackaged && process.platform === 'win32' && process.arch === 'x64',
        stopProviderWork: () => stopAccountWork(),
        verifyPublisher: (file) => verifyWindowsPublisher(file, config.licensing.updatePublisher),
        launch: (file) => launchWindowsInstaller(file, app.getPath('exe')),
        quit: () => app.quit(),
      },
    });
    const accountContext = userId ? new AccountContextManager(account, userId) : undefined;
    const accountPhoneSessions = userId ? new AccountPhoneSessions(account, userId) : undefined;
    let endForNoTime: () => Promise<void> = async () => undefined;
    const accountProviders = new AccountProviderRuntime(account, undefined, () => { void stopAccountWork(); },
      accountContext ? (prompt, signal) => accountContext.augmentForAnswer(prompt, signal) : undefined,
      active=>accountCredits?.activity(active),
      // A lost connection is restored in the background; the live page only needs to know it is happening.
      state => {
        if (state === 'exhausted') { void endForNoTime(); return; }
        emit('copilot:status', state === 'reconnecting' ? { status: 'recovering', message: 'Reconnecting audio…' }
          : state === 'restored' ? { status: 'listening', message: 'Audio reconnected' } : { status: 'recovering', message: 'Audio connection lost' });
      });
    config.accountManaged = true; config.providerMode = 'managed'; config.demoMode = false;
    config.gemini.apiKey = ''; config.deepgram.apiKey = '';
    config.gemini.model = MANAGED_GEMINI_MODEL; config.screen.model = MANAGED_GEMINI_MODEL;
    config.gemini.managedModelSelection = true;
    config.deepgram.model = MANAGED_DEEPGRAM_MODEL;
    config.gemini.managed = (body, signal) => accountProviders.generate(body, signal);
    config.deepgram.managed = undefined; // Account audio uses the shared runtime factory, not a second credential path.
    const models = new ModelCatalog(ACCOUNT_ORIGIN, {
      gemini: config.gemini.model, deepgram: config.deepgram.model,
    }, fetch, false, () => false, '/api/account/models');

    const workspaceDatabase = new Database(config.databasePath);
    await Promise.all([updates.initialize(), workspaceDatabase.initialize()]);
    // The window was closed while its workspace was opening: nothing more is registered.
    if (window.isDestroyed()) { workspaceDatabase.close(); return { async close() {}, shutdown() {} }; }
    database = workspaceDatabase;

    const repositories = new Repositories(workspaceDatabase);

    const retriever = new LocalRetriever(
      repositories,
      config.retrieval,
    );

    const model =
      config.demoMode
        ? new DemoAnswerModel()
        : new GeminiAnswerModel(
            config.gemini,
            new PromptBuilder(),
            async (modelId) => { await models.refresh(); return models.isAllowed('gemini', modelId); },
          );

    // ============================================================
    // EXISTING INTERVIEW ORCHESTRATOR
    // ============================================================

    const orchestrator =
      new InterviewOrchestrator(
        config,
        repositories,

        new IntentDetector(),

        new TurnGate(),

        new ContextBuilder(
          repositories,
          retriever,
        ),

        model,

        emit,
        accountProviders,
      );

    // ============================================================
    // EXISTING SESSION SERVICE
    // ============================================================

    const documentProcessor = new DocumentProcessor();
    const sessionService =
      new SessionService(
        repositories,

        documentProcessor,

        retriever,
        // The résumé of a saved session is also kept on the account, in the background.
        (session) => accountResumes?.collect(session),
      );
    const fileLibrary = new FileLibraryService(
      repositories,
      documentProcessor,
      path.join(path.dirname(config.databasePath), 'file-library'),
    );
    const accountResumes = userId ? new AccountResumes(account, userId, fileLibrary) : undefined;

    // ============================================================
    // EXISTING SCREEN ANALYZER
    // ============================================================

    const screenAnalyzer =
      config.demoMode
        ? new DemoScreenAnalyzer()
        : new GeminiScreenAnalyzer(
            {
              get apiKey() { return config.gemini.apiKey; },
              get managed() { return config.gemini.managed; },
              get managedModelSelection() { return config.gemini.managedModelSelection; },
              get model() { return config.screen.model; },
              timeoutMs: config.gemini.timeoutMs,
            },
            undefined,
            async (modelId) => { await models.refresh(); return models.isAllowed('gemini', modelId); },
          );

    // ============================================================
    // EXISTING IPC
    // ============================================================

    // From here until the handlers are registered nothing waits, so the page never finds one missing.
    loadingIpc.dispose();
    const { stopProtectedSession, dispose: disposeIpc } = registerIpc(
      window,
      config,
      repositories,
      sessionService,
      fileLibrary,
      orchestrator,
      screenAnalyzer,
      {
        isEntitled: () => account.status().state === 'active' && account.status().userId === userId,
        assertEntitled: () => {
          const state = account.status();
          if (state.state !== 'active' || !userId || state.userId !== userId) throw new Error('Sign in to your account to continue.');
        },
      },
      models,
      updates,
      undefined,
    );
    // Whatever ends the live work (sleep, a lost sign-in, a connection that could not be restored) also turns off the live
    // window mode and its shortcuts, so the live page must be told to match.
    stopAccountWork = async () => { emit('session:interrupted', null); accountProviders?.stop(); await stopProtectedSession(); };
    // The account's time ran out during a live session: it ends, and the page returns to the dashboard and says why.
    endForNoTime = async () => { emit('session:time-over', null); accountProviders.stop(); await stopProtectedSession(); void accountCredits?.refresh(); };
    const disposeAccountIpc = registerAccountIpc(window, account, { workspaceUserId: userId, updates, context: accountContext, credits:accountCredits, phoneSessions: accountPhoneSessions, stop: stopAccountWork,
      restart: () => switchAccount(),
    });

    return {
      async close() {
        await stopAccountWork().catch(() => undefined);
        stopAccountWork = async () => undefined;
        updates.cancelInstall();
        models.keepFresh(false);
        disposeAccountIpc();
        disposeIpc();
        answerWhileOpening();
        database?.close(); database = null;
      },
      shutdown() { accountProviders.stop(); void orchestrator.stop(); },
    };
  };

  let switching = false;
  /**
   * Opens the signed-in account's workspace in this window (the signed-out one when nobody is signed in). The app is
   * never restarted for this: the page shows a loading screen, then the account's dashboard.
   */
  const openCurrentAccount = async (): Promise<void> => {
    if (switching || window.isDestroyed()) return;
    switching = true;
    try {
      for (;;) {
        const state = account.status();
        const userId = state.state === 'active' ? state.userId : workspaceUserId;
        if (workspace && userId === workspaceUserId) break;
        if (workspace) {
          opening = loadingView('Opening your workspace…');
          sendAccount();
          const previous = workspace;
          workspace = undefined;
          await previous.close();
        }
        const next = await openWorkspace(userId);
        workspace = next;
        if (window.isDestroyed()) return;
      }
    } finally { switching = false; }
    opening = undefined;
    sendAccount();
  };
  const switchAccount = (): void => {
    setImmediate(() => {
      void openCurrentAccount().catch(() => {
        // Opening in place failed: restart the app, which opens the account from a clean start.
        console.error('{"component":"cluera-desktop","code":"WORKSPACE_SWITCH_FAILED"}');
        app.relaunch(); app.quit();
      });
    });
  };
  openWhenChanged = () => { if (workspace && !switching) switchAccount(); };

  const suspendUsage = (): void => { void stopAccountWork(); };
  const resumeUsage = (): void => { void account.restore().then(()=>accountCredits?.refresh()); };
  powerMonitor.on('suspend', suspendUsage);
  powerMonitor.on('resume', resumeUsage);
  const accountFocus = accountFocusCheck(account);
  const refreshAccountCredits=()=>{accountFocus.focus();accountCredits?.foreground();};
  window.on('focus',refreshAccountCredits);
  // A page that crashed cannot end its live session, so the app does.
  window.webContents.on('render-process-gone', () => { void stopAccountWork(); });

  // ============================================================
  // EXISTING WINDOW SHOW BEHAVIOR
  // ============================================================

  window.once(
    'ready-to-show',
    () => {
      window.show();
    },
  );

  // ============================================================
  // EXISTING WINDOW CLEANUP
  // ============================================================

  window.on(
    'closed',
    () => {
      workspace?.shutdown(); accountCredits?.dispose(); account.dispose();
      accountFocus.stop();window.removeListener('focus',refreshAccountCredits);
      powerMonitor.removeListener('suspend', suspendUsage);
      powerMonitor.removeListener('resume', resumeUsage);

      mainWindow = null;
    },
  );

  // ============================================================
  // EXISTING RENDERER LOADING
  // ============================================================

  window.webContents.on(
    'did-fail-load',
    (
      _event,
      code,
      description,
    ) => {
      console.error(
        'Renderer failed to load:',
        code,
        description,
      );
    },
  );

  const devRendererUrl = developmentRendererUrl(app.isPackaged, process.env.VITE_DEV_SERVER_URL);
  if (devRendererUrl) {
    await window.loadURL(devRendererUrl);
  } else {
    await window.loadFile(
      path.join(
        __dirname,
        '../renderer/index.html',
      ),
    );
  }

  // ============================================================
  // EXISTING DESKTOP BRIDGE CHECK
  // ============================================================

  setTimeout(
    () => {
      if (
        !preloadReady &&
        !window.isDestroyed()
      ) {
        emit(
          'app:error',
          {
            title:
              'Desktop bridge',

            message:
              'The sandboxed preload did not report ready. Rebuild main and preload, then restart Electron.',

            recoverable: false,
          },
        );
      }
    },
    4_000,
  );

  // The window is already up with its loading screen while the saved sign-in is checked and the workspace opens.
  await account.restore();
  await openCurrentAccount();

}

// ============================================================
// EXISTING ELECTRON STARTUP
// ============================================================

app.enableSandbox();

app
  .whenReady()
  .then(async () => {
    if (!ownsProfile) return;
    await createWindow();
    unregisterWindowVisibilityShortcut = registerWindowVisibilityShortcut(globalShortcut, () => mainWindow);
  })
  .catch(() => {
    const message = 'Cluera could not initialize its isolated workspace. Restart the app or contact support. Existing Account and License data have not been migrated.';
    console.error('{"component":"cluera-desktop","code":"INITIALIZATION_FAILED"}');

    dialog.showErrorBox(
      'Cluera AI could not start',
      message,
    );

    app.quit();
  });

// ============================================================
// EXISTING ELECTRON EVENTS
// ============================================================

app.on(
  'window-all-closed',
  () => {
    if (
      process.platform !==
      'darwin'
    ) {
      app.quit();
    }
  },
);

app.on(
  'activate',
  () => {
    if (!mainWindow) {
      void createWindow();
    }
  },
);

app.on(
  'will-quit',
  () => {
    unregisterWindowVisibilityShortcut();
    database?.close();
  },
);
