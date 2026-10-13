import path from 'node:path';
import fs from 'node:fs';
import { AccountSessionManager } from './accounts/AccountSessionManager';
import { AccountProviderRuntime } from './accounts/AccountProviderRuntime';
import { AccountContextManager } from './accounts/AccountContextManager';
import { AccountCreditsManager } from './accounts/AccountCreditsManager';
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

async function createWindow(): Promise<void> {
  let stopAccountWork: () => Promise<void> = async () => undefined;
  let workspaceUserId: string | undefined;
  let accountWasActive = false;
  let accountCredits:AccountCreditsManager|undefined;
  const account = new AccountSessionManager(
    new SecureJsonStore(path.join(accountProfile, 'secure-account-session.bin')), undefined, next => {
      const view = next.state === 'active' && next.userId !== workspaceUserId
        ? { mode: 'cluera-staging', state: 'checking', message: 'Opening your account workspace…' } : next;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('account:state', view);
      if (accountWasActive && next.state !== 'active') void stopAccountWork();
      accountWasActive = next.state === 'active';
      accountCredits?.ownerChanged();
    });
  if (account) {
    const state = await account.restore();
    workspaceUserId = state.state === 'active' ? state.userId : undefined;
    // No legacy import and no cross-account database/file-library reuse.
    const workspace = path.join(accountProfile, 'accounts', workspaceUserId ?? 'signed-out');
    fs.mkdirSync(workspace, { recursive: true }); app.setPath('userData', workspace);
  }
  const config = createAppConfig();
  if (accountPackage && config.licensing.serverUrl !== ACCOUNT_DISTRIBUTION.apiOrigin) throw new Error('Account API trust does not match this distribution.');
  if (account) {
    config.databasePath = path.join(app.getPath('userData'), ACCOUNT_DISTRIBUTION.database);
    config.licensing.enforced = false; // Account authorization never falls back to license keys.
  }

  const updates = new UpdateManager({
    enforced: config.isProduction,
    serverUrl: ACCOUNT_DISTRIBUTION.apiOrigin,
    publicKeyPem: config.licensing.publicKeyPem,
    trustedInstallerOrigins: config.licensing.trustedInstallerOrigins ?? [],
    appVersion: app.getVersion(),
    userDataPath: app.getPath('userData'),
    channel: ACCOUNT_DISTRIBUTION.channel,
    redirectOrigins: config.licensing.trustedInstallerRedirectOrigins,
    installer: {
      supported: () => app.isPackaged && process.platform === 'win32' && process.arch === 'x64',
      stopProviderWork: () => stopAccountWork(),
      verifyPublisher: (file) => verifyWindowsPublisher(file, config.licensing.updatePublisher),
      launch: (file) => launchWindowsInstaller(file, app.getPath('exe')),
      quit: () => app.quit(),
    },
  });
  const accountContext = account && workspaceUserId ? new AccountContextManager(account, workspaceUserId) : undefined;
  if(account) {
    accountCredits=new AccountCreditsManager(account,undefined,view=>{
      if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('account:credits-state',view);
    });
    accountCredits.ownerChanged();
  }
  const accountProviders = account ? new AccountProviderRuntime(account, undefined, () => { void stopAccountWork(); },
    accountContext ? (prompt, signal) => accountContext.augment(prompt, signal) : undefined,
    active=>accountCredits?.activity(active)) : undefined;
  const applyMode = (): void => {
    if (!accountProviders) throw new Error('Cluera account provider runtime is unavailable.');
    config.accountManaged = true; config.providerMode = 'managed'; config.demoMode = false;
    config.gemini.apiKey = ''; config.deepgram.apiKey = '';
    config.gemini.model = MANAGED_GEMINI_MODEL; config.screen.model = MANAGED_GEMINI_MODEL;
    config.gemini.managedModelSelection = true;
    config.deepgram.model = MANAGED_DEEPGRAM_MODEL;
    config.gemini.managed = (body, signal) => accountProviders.generate(body, signal);
    config.deepgram.managed = undefined; // Account audio uses the shared runtime factory, not a second credential path.
  };
  applyMode();
  const models = new ModelCatalog(ACCOUNT_ORIGIN, {
    gemini: config.gemini.model, deepgram: config.deepgram.model,
  }, fetch, false, () => false, '/api/account/models');
  await updates.initialize();

  database = new Database(config.databasePath);
  await database.initialize();

  const repositories = new Repositories(database);

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
      devTools: !config.isProduction,
    },
});

const window = mainWindow;
installTaskbarInvariant(window);
Menu.setApplicationMenu(null);
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-navigate', (event) => event.preventDefault());
window.webContents.on('before-input-event', (event, input) => {
  if (!config.isProduction || input.type !== 'keyDown') return;
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
    );
  const fileLibrary = new FileLibraryService(
    repositories,
    documentProcessor,
    path.join(path.dirname(config.databasePath), 'file-library'),
  );

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
          config.isProduction || account ? undefined : config.gemini.model,
          async (modelId) => { await models.refresh(); return models.isAllowed('gemini', modelId); },
        );

  // ============================================================
  // EXISTING IPC
  // ============================================================

  const suspendUsage = (): void => { void stopAccountWork(); };
  const resumeUsage = (): void => { void account.restore().then(()=>accountCredits?.refresh()); };
  powerMonitor.on('suspend', suspendUsage);
  powerMonitor.on('resume', resumeUsage);
  const { stopProtectedSession } = registerIpc(
    window,
    config,
    repositories,
    sessionService,
    fileLibrary,
    orchestrator,
    screenAnalyzer,
    {
      isEntitled: () => account.status().state === 'active' && account.status().userId === workspaceUserId,
      assertEntitled: () => {
        const state = account.status();
        if (state.state !== 'active' || !workspaceUserId || state.userId !== workspaceUserId) throw new Error('Sign in to your account to continue.');
      },
    },
    models,
    updates,
    undefined,
  );
  stopAccountWork = async () => { accountProviders?.stop(); await stopProtectedSession(); };
  let restartPending = false;
  registerAccountIpc(window, account, account ? { workspaceUserId, updates, context: accountContext, credits:accountCredits, stop: stopAccountWork,
    restart: () => {
      if (restartPending) return; restartPending = true;
      setImmediate(() => { accountProviders?.stop(); app.relaunch(); app.quit(); });
    },
  } : undefined);

  const accountFocus = account ? accountFocusCheck(account) : undefined;
  const refreshAccountCredits=()=>{accountFocus?.focus();void accountCredits?.refresh();};
  if(accountFocus)window.on('focus',refreshAccountCredits);

  // ============================================================
  // EXISTING RENDERER LOADING
  // ============================================================

  const devRendererUrl = developmentRendererUrl(config.isProduction, process.env.VITE_DEV_SERVER_URL);
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
      accountProviders?.stop(); accountCredits?.dispose(); account?.dispose();
      accountFocus?.stop();if(accountFocus)window.removeListener('focus',refreshAccountCredits);
      powerMonitor.removeListener('suspend', suspendUsage);
      powerMonitor.removeListener('resume', resumeUsage);
      void orchestrator.stop();

      mainWindow = null;
    },
  );

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
