import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain as electronIpc, screen, session, shell, type Rectangle } from 'electron';
import { trackedIpc } from './trackedIpc';
import { randomUUID } from 'node:crypto';
import { assertProviderSetup, assertSessionProviderSetup } from '../providers/providerSetup';
import { MANAGED_GEMINI_MODEL, MANAGED_DEEPGRAM_MODEL } from '../../shared/managedProviders';
import type { AppSettings, AudioSourceDescriptor, DocumentType, ExtractedDocument, LibraryFileCategory, ScreenCapturePreview, SelectedScreenSource, SessionInput, ShotKind } from '../../shared/types';
import { IPC } from '../../shared/ipc';
import { answerRequestSchema, appSettingsSchema, audioSourceSchema, sessionInputSchema, shotRequestSchema } from '../../shared/schemas';
import type { AppConfig } from '../config/appConfig';
import { Repositories } from '../database/Repositories';
import { SessionService } from '../app/SessionService';
import { FileLibraryService } from '../app/FileLibraryService';
import { InterviewOrchestrator } from '../interview/InterviewOrchestrator';
import type { ScreenAnalyzer } from '../screen/ScreenAnalyzer';
import { optimizeScreenImage, type OptimizedScreenImage } from '../screen/ScreenImageOptimizer';
import { dashboardWindowBounds, diagonalResizeBounds, FLOATING_LAUNCHER_SIZE, floatingLauncherBounds, sessionWindowBounds } from '../windowLayout';
import { ShotCapture } from '../screen/ShotCapture';
import { defaultWindowZoom, nextZoomFactor, zoomBySteps } from '../windowZoom';
import type { ModelCatalog } from '../providers/ModelCatalog';
import type { UpdateManager } from '../updates/UpdateManager';
import { openSupportDestination } from '../../shared/supportLinks';
import { announceHandoff } from '../browserHandoff';
import { ensureFocusableOffTaskbar, keepWindowOffTaskbar as enforceTaskbarInvariant } from '../windowTaskbar';

export function registerIpc(
  window: BrowserWindow,
  config: AppConfig,
  repositories: Repositories,
  sessions: SessionService,
  fileLibrary: FileLibraryService,
  interview: InterviewOrchestrator,
  screenAnalyzer: ScreenAnalyzer,
  authorization: { assertEntitled(): void; isEntitled(): boolean },
  models: ModelCatalog,
  updates: UpdateManager,
  usage?: { setActive(active: boolean): void },
): { stopProtectedSession(): Promise<void>; dispose(): void } {
  // Everything registered here can be removed again (dispose), so another account's workspace can open in this window.
  const ipcMain = trackedIpc(electronIpc);
  const requireAccess = (): void => { authorization.assertEntitled(); updates.assertSupported(); };
  type CaptureTimingMark = 'capture-complete' | 'optimization-start' | 'optimization-complete' | 'approval-start' | 'rag-start' | 'rag-complete' | 'gemini-request-start' | 'first-token' | 'first-visible' | 'full-response-complete';
  interface CaptureTiming { startedAt: number; marks: Partial<Record<CaptureTimingMark, number>> }
  interface PendingCapture { preview: ScreenCapturePreview; optimizedImage: Promise<OptimizedScreenImage> }
  let pendingCapture: PendingCapture | null = null;
  const shots = new ShotCapture(window, config.screen.maxDimension);
  let captureInProgress = false;
  let manualZoomSelected = false;
  let captureEpoch = 0;
  let selectedScreenSource: SelectedScreenSource | null = null;
  const captureTimings = new Map<string, CaptureTiming>();
  const markTiming = (captureId: string, mark: CaptureTimingMark): void => {
    const timing = captureTimings.get(captureId);
    if (!timing || timing.marks[mark] !== undefined) return;
    const now = performance.now();
    timing.marks[mark] = now;
    if (mark === 'full-response-complete') setTimeout(() => captureTimings.delete(captureId), 60_000);
    if (!config.debugMode) return;
    const elapsed = Math.round(now - timing.startedAt);
    const durationFrom = (from: CaptureTimingMark): number | undefined => timing.marks[from] === undefined ? undefined : Math.round(now - timing.marks[from]!);
    const durationMs = mark === 'optimization-complete' ? durationFrom('optimization-start')
      : mark === 'rag-complete' ? durationFrom('rag-start')
        : mark === 'first-token' ? durationFrom('gemini-request-start')
          : mark === 'full-response-complete' ? durationFrom('gemini-request-start')
            : undefined;
    console.debug('[screen-timing]', { captureId, milestone: mark, elapsedFromSelectionMs: elapsed, ...(durationMs === undefined ? {} : { durationMs }) });
  };
  let approvedAbort: AbortController | null = null;
  let analysisInProgress = false;
  let systemAudioSource: { id: string; name: string } | null = null;
  let overlayMode = false;
  let sessionModeActive = false;
  let roundSessionId: string | null = null;
  let pendingRoundStarts = 0;
  let preSessionBounds: Rectangle | null = null;
  let preSessionZoomFactor: number | null = null;
  let preSessionHasShadow: boolean | null = null;
  let expandedLiveBounds: Rectangle | null = null;
  let expandedLiveZoomFactor: number | null = null;
  let expandedLiveMaximumSize: number[] | null = null;
  let expandedLiveMinimumSize: number[] | null = null;
  let expandedLiveAlwaysOnTop: boolean | null = null;
  let expandedLiveHasShadow: boolean | null = null;
  let liveCollapsed = false;
  let collapsedDragOrigin: { bounds: Rectangle; pointerX: number; pointerY: number } | null = null;
  let liveResizeOrigin: Rectangle | null = null;
  let explicitCloseRequested = false;
  let applicationQuitting = false;
  let quickShotShortcutRegistered = false;
  const releaseQuickShotShortcut = (): void => {
    if (!quickShotShortcutRegistered) return;
    globalShortcut.unregister('Alt+C');
    quickShotShortcutRegistered = false;
  };
  const enableQuickShotShortcut = (): void => {
    if (quickShotShortcutRegistered) return;
    quickShotShortcutRegistered = globalShortcut.register('Alt+C', () => {
      if (!sessionModeActive || !authorization.isEntitled() || applicationQuitting || window.isDestroyed()
        || window.webContents.isDestroyed() || captureInProgress || analysisInProgress) return;
      // Dispatch the existing camera action without activating the window.
      window.webContents.send(IPC.events, 'screen:quick-shot', null);
    });
    if (!quickShotShortcutRegistered) {
      window.webContents.send(IPC.events, 'app:error', {
        title: 'Screenshot shortcut',
        message: 'Alt+C is unavailable or already used by another application. The camera button still works.',
        recoverable: true,
      });
    }
  };
  // Alt+S sends the question shown on the live page when Auto Answer is off. It is registered only while the
  // page asks for it (a running session with Auto Answer off), so the key is free for other apps the rest of the time.
  let sendShortcutRegistered = false;
  const releaseSendShortcut = (): void => {
    if (!sendShortcutRegistered) return;
    globalShortcut.unregister('Alt+S');
    sendShortcutRegistered = false;
  };
  const enableSendShortcut = (): boolean => {
    if (sendShortcutRegistered) return true;
    sendShortcutRegistered = globalShortcut.register('Alt+S', () => {
      if (!sessionModeActive || !authorization.isEntitled() || applicationQuitting || window.isDestroyed()
        || window.webContents.isDestroyed()) return;
      // Dispatch the existing Send action without activating the window, so the meeting keeps keyboard focus.
      window.webContents.send(IPC.events, 'answer:send-shortcut', null);
    });
    return sendShortcutRegistered;
  };
  // Assignment sessions: the window ignores the mouse, so clicks reach the page behind it (the assignment), and a few
  // shortcuts replace the controls. Alt+M turns touch back on, and it is always registered first: if it cannot be,
  // clicks are never blocked, so the customer cannot be locked out of the window.
  let assignmentModeActive = false;
  let touchThrough = false;
  const assignmentKeys: string[] = [];
  const setTouchThrough = (enabled: boolean): void => {
    touchThrough = enabled;
    if (!window.isDestroyed()) window.setIgnoreMouseEvents(enabled, { forward: true });
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.events, 'window:touch-through', { enabled });
  };
  const releaseAssignmentMode = (): void => {
    for (const key of assignmentKeys.splice(0)) globalShortcut.unregister(key);
    assignmentModeActive = false;
    if (touchThrough) setTouchThrough(false);
  };
  const enableAssignmentMode = (): boolean => {
    if (assignmentModeActive) return true;
    const live = (): boolean => sessionModeActive && authorization.isEntitled() && !applicationQuitting && !window.isDestroyed() && !window.webContents.isDestroyed();
    const register = (key: string, action: () => void): boolean => {
      // Only this app's own registrations are reported here, so releasing one that was left behind is always safe.
      if (globalShortcut.isRegistered?.(key)) globalShortcut.unregister(key);
      if (!globalShortcut.register(key, () => { if (live()) action(); })) return false;
      assignmentKeys.push(key);
      return true;
    };
    if (!register('Alt+M', () => setTouchThrough(!touchThrough))) return false;
    register('Alt+Up', () => window.webContents.send(IPC.events, 'answer:scroll', { direction: -1 }));
    register('Alt+Down', () => window.webContents.send(IPC.events, 'answer:scroll', { direction: 1 }));
    register('Alt+A', () => window.webContents.send(IPC.events, 'answer:navigate', { delta: -1 }));
    register('Alt+D', () => window.webContents.send(IPC.events, 'answer:navigate', { delta: 1 }));
    assignmentModeActive = true;
    setTouchThrough(true);
    return true;
  };
  // Showing, restoring or re-pinning the window must never quietly give the mouse back while clicks should pass through.
  const reassertTouchThrough = (): void => {
    if (assignmentModeActive && touchThrough && !window.isDestroyed()) window.setIgnoreMouseEvents(true, { forward: true });
  };
  const touchGuardEvents = ['show', 'restore', 'focus', 'always-on-top-changed'] as const;
  for (const eventName of touchGuardEvents) window.on(eventName as 'show', reassertTouchThrough);
  // If the page crashes while clicks pass through, give the mouse back at once.
  window.webContents.on?.('render-process-gone', releaseAssignmentMode);
  const keepWindowOffTaskbar = (): void => {
    enforceTaskbarInvariant(window);
  };
  const keepWindowPinned = (): void => {
    if (!window.isDestroyed()) window.setAlwaysOnTop(true, 'screen-saver', 1);
  };
  const allowApplicationQuit = (): void => { applicationQuitting = true; releaseQuickShotShortcut(); releaseSendShortcut(); releaseAssignmentMode(); };
  app.on('before-quit', allowApplicationQuit);
  const releaseOnClosed = (): void => {
    releaseQuickShotShortcut();
    releaseSendShortcut();
    releaseAssignmentMode();
    for (const eventName of touchGuardEvents) window.removeListener(eventName as 'show', reassertTouchThrough);
    app.removeListener('before-quit', allowApplicationQuit);
  };
  window.once('closed', releaseOnClosed);
  const preventClose = (event: Electron.Event): void => {
    if (explicitCloseRequested || applicationQuitting) return;
    event.preventDefault();
    keepWindowOffTaskbar();
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.showInactive();
    keepWindowOffTaskbar();
    keepWindowPinned();
  };
  window.on('close', preventClose);
  const keepRestored = (): void => {
    setImmediate(() => {
      if (window.isDestroyed()) return;
      keepWindowOffTaskbar();
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.showInactive();
      keepWindowOffTaskbar();
      keepWindowPinned();
    });
  };
  window.on('minimize', keepRestored);
  // The source chosen for this capture is reused as it is: listing every window again here delayed the sound.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    if (!systemAudioSource) { callback({}); return; }
    callback({ video: systemAudioSource, audio: 'loopback' });
  });
  ipcMain.handle(IPC.app.status, async (_event, fresh?: unknown) => {
    requireAccess();
    // Opening or saving a session reloads the list, so a change made in Admin shows at once. Every other read keeps the short-lived copy.
    await models.refresh(fresh === true);
    requireAccess();
    return {
    providerMode: config.providerMode ?? 'byok',
    demoMode: config.demoMode, development: !config.isProduction, deepgramConfigured: Boolean(config.accountManaged || config.deepgram.apiKey || config.deepgram.managed), geminiConfigured: Boolean(config.gemini.apiKey || config.gemini.managed),
    databasePath: config.databasePath, models: models.choices('gemini').map((option) => option.modelId),
    modelOptions: models.choices('gemini'), deepgramModelOptions: models.choices('deepgram'),
    defaultGeminiModel: config.accountManaged ? models.defaultModel('gemini') : config.providerMode === 'managed' ? MANAGED_GEMINI_MODEL : config.gemini.model,
    defaultDeepgramModel: config.providerMode === 'managed' ? MANAGED_DEEPGRAM_MODEL : config.deepgram.model,
    screenAnalysisEnabled: config.screen.enabled,
    sessionDefaults: models.sessionDefaults(),
    };
  });
  ipcMain.handle(IPC.app.close, (event) => {
    if (event.sender !== window.webContents) throw new Error('Unauthorized close request.');
    explicitCloseRequested = true;
    window.close();
  });
  ipcMain.handle(IPC.app.openExternal, async (_event, kind: unknown) => {
    if (kind === 'supportGmail' || kind === 'supportMail') {
      await openSupportDestination(kind, (url) => shell.openExternal(url));
      announceHandoff(window, { phase: 'away', purpose: 'help' });
      return;
    }
    if (kind !== 'tutorial' && kind !== 'support') throw new Error('Unknown external destination.');
    const target = config.links?.[kind] ?? (kind === 'tutorial' ? 'https://www.youtube.com/' : 'https://www.clueraai.in/support');
    const url = new URL(target);
    if (url.protocol !== 'https:') throw new Error('External links must use HTTPS.');
    await shell.openExternal(url.toString());
    announceHandoff(window, { phase: 'away', purpose: 'help' });
  });
  ipcMain.handle(IPC.app.adjustZoom, (_event, direction: unknown) => {
    if (direction !== 'in' && direction !== 'out') throw new Error('Zoom direction must be in or out.');
    if (liveCollapsed) return 1;
    const zoom = nextZoomFactor(window.webContents.getZoomFactor(), direction);
    window.webContents.setZoomFactor(zoom);
    manualZoomSelected = true;
    return zoom;
  });
  ipcMain.handle(IPC.app.focusLiveTranscript, async (event, forceQuestionFocus: unknown) => {
    if (event.sender !== window.webContents || !sessionModeActive || liveCollapsed || !window.isVisible()) return false;
    // An assignment is worked on in another window: hearing a question must never pull the keyboard away from it.
    if (assignmentModeActive) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!window.isFocused()) {
        ensureFocusableOffTaskbar(window);
        window.moveTop();
        // Windows normally prevents background applications from taking the
        // keyboard unexpectedly. Manual answering explicitly requests this
        // foreground handoff; Auto Answer ON never sends the force flag.
        if (forceQuestionFocus === true && process.platform === 'win32') app.focus();
        window.focus();
      }
      window.webContents.focus();
      if (window.isFocused()) return true;
      await new Promise<void>((resolve) => setTimeout(resolve, 40 + attempt * 40));
    }
    return window.isFocused();
  });
  const setSessionMode = (active: boolean): void => {
    if (active) requireAccess();
    keepWindowOffTaskbar();
    const nextSessionMode = Boolean(active);
    if (nextSessionMode && !sessionModeActive) {
      preSessionBounds = window.getBounds();
      preSessionZoomFactor = window.webContents.getZoomFactor();
      preSessionHasShadow = window.hasShadow();
    }
    sessionModeActive = nextSessionMode;
    if (sessionModeActive) enableQuickShotShortcut();
    else { releaseQuickShotShortcut(); releaseSendShortcut(); releaseAssignmentMode(); }
    overlayMode = false;
    if (!sessionModeActive && liveCollapsed) {
      liveCollapsed = false;
      if (expandedLiveMaximumSize) window.setMaximumSize(expandedLiveMaximumSize[0], expandedLiveMaximumSize[1]);
      if (expandedLiveMinimumSize) window.setMinimumSize(expandedLiveMinimumSize[0], expandedLiveMinimumSize[1]);
      if (expandedLiveZoomFactor !== null) window.webContents.setZoomFactor(expandedLiveZoomFactor);
      if (expandedLiveAlwaysOnTop !== null) keepWindowPinned();
      if (expandedLiveHasShadow !== null) window.setHasShadow(expandedLiveHasShadow);
      expandedLiveBounds = null;
      expandedLiveZoomFactor = null;
      expandedLiveMaximumSize = null;
      expandedLiveMinimumSize = null;
      expandedLiveAlwaysOnTop = null;
      expandedLiveHasShadow = null;
    }
    keepWindowPinned();
    if (sessionModeActive) {
      // Keep the Windows DWM frame/shadow disabled for the entire borderless
      // live session. Re-enabling it after restoring the circular launcher can
      // leave an accent-colored rectangular edge around a transparent window.
      window.setHasShadow(false);
      window.setMinimumSize(320, 240);
      const display = screen.getDisplayMatching(window.getBounds());
      window.setBounds(sessionWindowBounds(display.workArea), true);
      if (!manualZoomSelected) window.webContents.setZoomFactor(zoomBySteps(defaultWindowZoom(sessionWindowBounds(display.workArea)), 'in', 3));
    } else {
      window.setMinimumSize(420, 360);
      const dashboardDisplay = screen.getDisplayMatching(preSessionBounds ?? window.getBounds());
      const dashboardBounds = dashboardWindowBounds(dashboardDisplay.workArea);
      window.setBounds(dashboardBounds, true);
      window.webContents.setZoomFactor(preSessionZoomFactor ?? zoomBySteps(defaultWindowZoom(dashboardBounds), 'in', 3));
      if (preSessionHasShadow !== null) window.setHasShadow(preSessionHasShadow);
      preSessionBounds = null;
      preSessionZoomFactor = null;
      preSessionHasShadow = null;
    }
    keepWindowOffTaskbar();
  };
  ipcMain.handle(IPC.app.sessionMode, (_event, active: boolean) => setSessionMode(active));
  const setLiveCollapse = (collapsed: boolean): void => {
    keepWindowOffTaskbar();
    const next = Boolean(collapsed);
    if (next === liveCollapsed) {
      // Safety net: if the page asks to restore but the window is still launcher-sized (the two sides
      // disagreed about the state), grow it back instead of leaving a tiny window the user cannot use.
      if (!next) {
        const current = window.getBounds();
        if (current.width <= FLOATING_LAUNCHER_SIZE + 12 || current.height <= FLOATING_LAUNCHER_SIZE + 12) {
          const area = screen.getDisplayMatching(current).workArea;
          window.setMinimumSize(sessionModeActive ? 320 : 420, sessionModeActive ? 240 : 360);
          window.setMaximumSize(0, 0);
          window.setBounds(sessionModeActive ? sessionWindowBounds(area) : dashboardWindowBounds(area), false);
          window.setHasShadow(sessionModeActive ? false : true);
          window.setBackgroundColor('#00000000');
          keepWindowPinned();
        }
      }
      keepWindowOffTaskbar();
      return;
    }
    if (next) {
      expandedLiveBounds = window.getBounds();
      expandedLiveZoomFactor = window.webContents.getZoomFactor();
      expandedLiveMaximumSize = window.getMaximumSize();
      expandedLiveMinimumSize = window.getMinimumSize();
      expandedLiveAlwaysOnTop = window.isAlwaysOnTop();
      expandedLiveHasShadow = window.hasShadow();
      const bounds = expandedLiveBounds;
      liveCollapsed = true;
      collapsedDragOrigin = null;
      window.webContents.setZoomFactor(1);
      keepWindowPinned();
      window.setBackgroundColor('#00000000');
      window.setHasShadow(false);
      window.setMinimumSize(FLOATING_LAUNCHER_SIZE, FLOATING_LAUNCHER_SIZE);
      // Keep WS_THICKFRAME unchanged. Removing and re-adding it with
      // setResizable(false/true) can leave a Windows accent-colored rectangle
      // around this transparent frameless window after restore. Equal minimum
      // and maximum dimensions still make the launcher non-resizable.
      window.setMaximumSize(FLOATING_LAUNCHER_SIZE, FLOATING_LAUNCHER_SIZE);
      const display = screen.getDisplayMatching(bounds);
      window.setBounds(floatingLauncherBounds(display.workArea), false);
      keepWindowOffTaskbar();
      return;
    }
    liveCollapsed = false;
    collapsedDragOrigin = null;
    if (expandedLiveMaximumSize) window.setMaximumSize(expandedLiveMaximumSize[0], expandedLiveMaximumSize[1]);
    if (expandedLiveMinimumSize) window.setMinimumSize(expandedLiveMinimumSize[0], expandedLiveMinimumSize[1]);
    if (expandedLiveBounds) {
      const restoredBounds = sessionModeActive
        ? expandedLiveBounds
        : dashboardWindowBounds(screen.getDisplayMatching(expandedLiveBounds).workArea);
      window.setBounds(restoredBounds, false);
    }
    if (expandedLiveZoomFactor !== null) window.webContents.setZoomFactor(expandedLiveZoomFactor);
    if (expandedLiveAlwaysOnTop !== null) keepWindowPinned();
    // Live mode deliberately remains shadowless; dashboard pages recover the
    // exact shadow state they had before collapsing.
    window.setHasShadow(sessionModeActive ? false : expandedLiveHasShadow ?? true);
    window.setBackgroundColor('#00000000');
    expandedLiveBounds = null;
    expandedLiveZoomFactor = null;
    expandedLiveMaximumSize = null;
    expandedLiveMinimumSize = null;
    expandedLiveAlwaysOnTop = null;
    expandedLiveHasShadow = null;
    keepWindowOffTaskbar();
  };
  ipcMain.handle(IPC.app.liveCollapse, (_event, collapsed: boolean) => setLiveCollapse(collapsed));
  ipcMain.on(IPC.app.moveLiveCollapse, (event, phase: string, screenX?: number, screenY?: number) => {
    if (!liveCollapsed || event.sender !== window.webContents) return;
    if (phase === 'end') { collapsedDragOrigin = null; return; }
    const pointerX = Number(screenX);
    const pointerY = Number(screenY);
    if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return;
    if (phase === 'start') {
      collapsedDragOrigin = { bounds: window.getBounds(), pointerX, pointerY };
      window.moveTop();
      window.focus();
      return;
    }
    if (phase !== 'move' || !collapsedDragOrigin) return;
    const { bounds, pointerX: startX, pointerY: startY } = collapsedDragOrigin;
    const proposedX = bounds.x + Math.round(pointerX - startX);
    const proposedY = bounds.y + Math.round(pointerY - startY);
    const display = screen.getDisplayNearestPoint({ x: proposedX + Math.round(bounds.width / 2), y: proposedY + Math.round(bounds.height / 2) });
    const area = display.workArea;
    window.setPosition(
      Math.max(area.x, Math.min(proposedX, area.x + area.width - bounds.width)),
      Math.max(area.y, Math.min(proposedY, area.y + area.height - bounds.height)),
      false,
    );
  });
  ipcMain.on(IPC.app.resizeLive, (event, phase: string, deltaX = 0, deltaY = 0, diagonal = false) => {
    // The same native, top-left-anchored resize path is used by the live
    // workspace and each standalone page's small corner handle.
    if (liveCollapsed || event.sender !== window.webContents) {
      liveResizeOrigin = null;
      return;
    }
    if (phase === 'start') {
      liveResizeOrigin = window.getBounds();
      return;
    }
    if (phase === 'end') {
      liveResizeOrigin = null;
      return;
    }
    if (phase !== 'move' || !liveResizeOrigin) return;
    const dx = Number(deltaX);
    const dy = Number(deltaY);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const origin = liveResizeOrigin;
    const [minimumWidth, minimumHeight] = window.getMinimumSize();
    const display = screen.getDisplayMatching(origin);
    const maximumWidth = Math.max(minimumWidth, display.workArea.x + display.workArea.width - origin.x);
    const maximumHeight = Math.max(minimumHeight, display.workArea.y + display.workArea.height - origin.y);
    if (diagonal === true) {
      window.setBounds(diagonalResizeBounds(
        origin,
        dx,
        dy,
        { width: minimumWidth, height: minimumHeight },
        { width: maximumWidth, height: maximumHeight },
      ), false);
      return;
    }
    const width = Math.max(minimumWidth, Math.min(maximumWidth, Math.round(origin.width + dx)));
    const height = Math.max(minimumHeight, Math.min(maximumHeight, Math.round(origin.height + dy)));
    // Reapply the pointer-down origin on every frame. setSize() can let the
    // Windows frame manager shift a transparent always-on-top window while it
    // is being resized; explicit bounds keep the top-left completely stable.
    window.setBounds({ x: origin.x, y: origin.y, width, height }, false);
  });
  ipcMain.handle(IPC.app.toggleOverlay, () => {
    overlayMode = !overlayMode;
    keepWindowPinned();
    if (sessionModeActive && !overlayMode) {
      const display = screen.getDisplayMatching(window.getBounds());
      window.setMinimumSize(320, 240);
      window.setBounds(sessionWindowBounds(display.workArea), true);
    } else {
      window.setMinimumSize(overlayMode ? 380 : 520, overlayMode ? 260 : 600);
      window.setSize(overlayMode ? 560 : 1180, overlayMode ? 680 : 760, true);
    }
  });
  ipcMain.handle(IPC.sessions.list, () => { requireAccess(); return repositories.listSessions(); });
  ipcMain.handle(IPC.sessions.get, (_event, id: string) => { requireAccess(); return repositories.getDetail(id); });
  ipcMain.handle(IPC.sessions.save, async (_event, input: SessionInput) => {
    requireAccess();
    const parsed = sessionInputSchema.parse(input);
    await models.refresh();
    requireAccess();
    assertSessionProviderSetup(config, models, parsed.selectedModel);
    if ((config.accountManaged || config.providerMode !== 'managed') && !models.isAllowed('gemini', parsed.selectedModel)) throw new Error('The selected AI model is unavailable in Cluera\'s model catalog. Choose an enabled model.');
    return sessions.save(parsed);
  });
  ipcMain.handle(IPC.sessions.delete, (_event, id: string) => { requireAccess(); return repositories.deleteSession(id); });
  ipcMain.handle(IPC.sessions.summary, (_event, id: string) => { requireAccess(); return repositories.summary(id); });
  ipcMain.handle(IPC.documents.select, async (_event, input: { sessionId: string; type: DocumentType }) => {
    requireAccess();
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['pdf','docx','txt','md','markdown'] }] });
    return selection.canceled ? null : sessions.addFile(input.sessionId, input.type, selection.filePaths[0]);
  });
  ipcMain.handle(IPC.documents.read, async () => {
    requireAccess();
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['pdf','docx','txt','md','markdown'] }] });
    return selection.canceled ? null : sessions.extractFile(selection.filePaths[0]);
  });
  ipcMain.handle(IPC.documents.addExtracted, (_event, input: { sessionId: string; type: DocumentType; document: ExtractedDocument }) => { requireAccess(); return sessions.addExtracted(input.sessionId, input.type, input.document); });
  ipcMain.handle(IPC.documents.addText, (_event, input: { sessionId: string; type: DocumentType; name: string; text: string }) => { requireAccess(); return sessions.addText(input.sessionId, input.type, input.name, input.text); });
  ipcMain.handle(IPC.documents.remove, (_event, id: string) => { requireAccess(); return repositories.removeDocument(id); });
  ipcMain.handle(IPC.library.list, () => { requireAccess(); return fileLibrary.list(); });
  ipcMain.handle(IPC.library.upload, async (_event, category: LibraryFileCategory) => {
    requireAccess();
    if (category !== 'resume' && category !== 'supporting') throw new Error('Unknown saved-file category.');
    const filters = [{ name: category === 'resume' ? 'Resume documents' : 'Supporting documents',
      extensions: ['pdf','docx','txt','md','markdown'] }];
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters });
    return selection.canceled ? null : fileLibrary.upload(category, selection.filePaths[0]);
  });
  ipcMain.handle(IPC.library.get, (_event, id: string) => { requireAccess(); return fileLibrary.get(id); });
  ipcMain.handle(IPC.library.delete, (_event, id: string) => { requireAccess(); return fileLibrary.delete(id); });
  ipcMain.handle(IPC.sessions.startRound, (event, id: unknown, note: unknown) => {
    requireAccess();
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized round request.');
    if (sessionModeActive || roundSessionId || stoppingProtectedSession || pendingRoundStarts) throw new Error('End the live session before starting another round.');
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id) || typeof note !== 'string' || note.length > 2000) throw new Error('Invalid round details.');
    sessions.startRound(id, note);
  });
  ipcMain.handle(IPC.sessions.roundHistory, (event, id: unknown, round: unknown, page: unknown) => {
    requireAccess();
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized history request.');
    if (typeof id !== 'string' || id.length > 100 || typeof round !== 'string' || round.length > 150 || typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page > 100000) throw new Error('Invalid history request.');
    return repositories.roundHistory(id, round, page);
  });
  ipcMain.handle(IPC.interview.start, async (_event, sessionId: string, source: AudioSourceDescriptor, interactionEnabled?: unknown) => {
    requireAccess();
    const finishStart = updates.beginSessionStart();
    pendingRoundStarts += 1;
    try {
    assertProviderSetup(config, 'gemini');
    assertProviderSetup(config, 'deepgram');
    await models.refresh();
    requireAccess();
    if (config.providerMode !== 'managed' && !models.isAllowed('deepgram', config.deepgram.model)) throw new Error('The selected Deepgram model is no longer enabled. Choose another model in Settings.');
    const selectedSession = repositories.getSession(sessionId);
    if ((config.accountManaged || config.providerMode !== 'managed') && selectedSession && !models.isAllowed('gemini', selectedSession.selectedModel)) throw new Error('The session AI model is no longer enabled. Choose another model in Edit Session.');
    if (interactionEnabled !== undefined && typeof interactionEnabled !== 'boolean') throw new Error('Interview interaction state must be a boolean.');
    await interview.start(sessionId, audioSourceSchema.parse(source), interactionEnabled ?? true);
    repositories.ensureRound(sessionId);
    roundSessionId = sessionId;
    // Account access may be revoked while Deepgram is opening its connection.
    if (!authorization.isEntitled()) {
      await stopProtectedSession();
      // A connection that finished starting after the first stop needs one
      // final close before the start IPC can settle.
      await interview.stop();
      throw new Error('Sign in to your verified Cluera account to continue.');
    }
    finishStart(true);
    models.keepFresh(true);
    usageInteraction = interactionEnabled ?? true;
    usagePaused = false;
    usage?.setActive(usageInteraction);
    } catch (error) { finishStart(false); throw error; }
    finally { pendingRoundStarts -= 1; }
  });
  let stoppingProtectedSession: Promise<void> | null = null;
  let usageInteraction = false;
  let usagePaused = false;
  const stopProtectedSession = (): Promise<void> => {
    models.keepFresh(false);
    usageInteraction = false;
    usage?.setActive(false);
    if (stoppingProtectedSession) return stoppingProtectedSession;
    // Stopping capture must remain possible even if account access or update state
    // changes while a session is running.
    captureEpoch += 1;
    try { shots.cancel(); } catch { /* Continue shutting down the interview. */ }
    approvedAbort?.abort();
    approvedAbort = null;
    pendingCapture = null;
    selectedScreenSource = null;
    systemAudioSource = null;
    captureTimings.clear();
    if (sessionModeActive || liveCollapsed) {
      try { setSessionMode(false); } catch { /* Continue shutting down the interview. */ }
    }
    const endingRound = roundSessionId;
    roundSessionId = null;
    const stopping = interview.stop().then(() => {
      if (!endingRound) return;
      try { sessions.finishRound(endingRound); }
      catch {
        // Indexing is local/retryable and must not strand stopped providers or
        // the update-session gate. Never include transcript text in diagnostics.
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.events, 'app:error', {
          title: 'Round history', message: 'Round finalization could not finish. Saved records are retained; reopen the interview to retry.', recoverable: true,
        });
      }
    });
    stoppingProtectedSession = stopping;
    void stopping.then(
      () => { if (stoppingProtectedSession === stopping) { stoppingProtectedSession = null; updates.endSession(); } },
      () => { if (stoppingProtectedSession === stopping) stoppingProtectedSession = null; },
    );
    return stopping;
  };
  ipcMain.handle(IPC.interview.stop, stopProtectedSession);
  ipcMain.handle(IPC.interview.pause, (_event, paused: boolean) => {
    requireAccess();
    const result = interview.pause(paused);
    usagePaused = paused;
    usage?.setActive(usageInteraction && !usagePaused);
    return result;
  });
  ipcMain.handle(IPC.interview.interaction, (_event, enabled: unknown) => {
    requireAccess();
    if (typeof enabled !== 'boolean') throw new Error('Interview interaction state must be a boolean.');
    if (!enabled) { approvedAbort?.abort(); approvedAbort = null; }
    const result = interview.setInteractionEnabled(enabled);
    usageInteraction = result && roundSessionId !== null;
    usage?.setActive(usageInteraction && !usagePaused);
    return result;
  });
  ipcMain.handle(IPC.interview.autoAnswer, (_event, enabled: unknown) => {
    requireAccess();
    if (typeof enabled !== 'boolean') throw new Error('Auto Answer must be enabled or disabled explicitly.');
    return interview.setAutoAnswerEnabled(enabled);
  });
  ipcMain.handle(IPC.interview.answer, (_event, input: unknown) => { requireAccess(); assertProviderSetup(config, 'gemini'); return interview.answer(answerRequestSchema.parse(input)); });
  ipcMain.handle(IPC.interview.clear, () => { requireAccess(); return interview.clear(); });
  ipcMain.handle(IPC.app.assignmentMode, (event, enabled: unknown) => {
    if (event.sender !== window.webContents) throw new Error('Unauthorized window request.');
    requireAccess();
    if (typeof enabled !== 'boolean') throw new Error('Assignment mode must be enabled or disabled explicitly.');
    if (!enabled) { releaseAssignmentMode(); return { active: false, touchThrough: false }; }
    // Only the live page asks this, and only while a session runs. If the live window mode was lost on the way (a
    // shutdown that raced with this page), bring it back instead of silently refusing.
    if (!sessionModeActive) setSessionMode(true);
    const active = enableAssignmentMode();
    return { active, touchThrough: active && touchThrough };
  });
  ipcMain.handle(IPC.interview.discardInput, () => { requireAccess(); interview.discardInput(); });
  ipcMain.handle(IPC.app.sendShortcut, (event, enabled: unknown) => {
    if (event.sender !== window.webContents) throw new Error('Unauthorized shortcut request.');
    requireAccess();
    if (typeof enabled !== 'boolean') throw new Error('The send shortcut must be enabled or disabled explicitly.');
    if (!enabled || !sessionModeActive) { releaseSendShortcut(); return false; }
    return enableSendShortcut();
  });
  ipcMain.on(IPC.audio.chunk, (_event, sourceId: string, chunk: ArrayBuffer) => {
    if (!authorization.isEntitled()) return;
    if ((sourceId === 'system' || sourceId === 'candidate') && chunk.byteLength === 2_560) {
      interview.sendAudio(sourceId, Buffer.from(chunk));
    }
  });
  ipcMain.on(IPC.audio.error, (_event, message: string) => window.webContents.send(IPC.events, 'app:error', { title: 'Audio capture', message, recoverable: true }));
  const useSystemAudioSource = (source: { id: string; name: string }): { id: string; name: string } => {
    systemAudioSource = { id: source.id, name: source.name };
    return systemAudioSource;
  };
  ipcMain.handle(IPC.audio.selectSystemSource, async (_event, sourceId: string) => {
    requireAccess();
    const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
    const selected = sources.find((source) => source.id === sourceId);
    if (!selected) throw new Error('The selected system-audio source is no longer available.');
    return useSystemAudioSource(selected).name;
  });
  // The loopback audio is the same whichever screen carries it, so only screens are listed, without thumbnails: that
  // takes a fraction of a second, while listing every window with a picture of each could take many seconds.
  ipcMain.handle(IPC.audio.defaultSystemSource, async () => {
    requireAccess();
    const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const primary = screens.find((source) => source.display_id === String(screen.getPrimaryDisplay().id)) ?? screens[0];
    if (!primary) throw new Error('Windows did not list a screen for output audio.');
    return useSystemAudioSource(primary);
  });
  ipcMain.handle(IPC.screen.sources, async () => {
    requireAccess();
    const ownIds = new Set(BrowserWindow.getAllWindows().map(item => item.getMediaSourceId()));
    return (await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false }))
      .filter(source => !ownIds.has(source.id))
      .map((source) => ({ id: source.id, name: source.name, thumbnailDataUrl: source.thumbnail.toDataURL() }));
  });
  const captureShot = async (kind: ShotKind, sourceId?: string, keepAppVisible = false): Promise<ScreenCapturePreview | null> => {
    requireAccess();
    if (!config.screen.enabled) throw new Error('Screen analysis is disabled.');
    if (captureInProgress || analysisInProgress) throw new Error('Finish or cancel the current shot before taking another.');
    if (sourceId && BrowserWindow.getAllWindows().some(item => item.getMediaSourceId() === sourceId)) throw new Error('Choose a window outside Cluera AI.');
    captureInProgress = true;
    const epoch = captureEpoch;
    const captureId = randomUUID();
    captureTimings.set(captureId, { startedAt: performance.now(), marks: {} });
    try {
      const frame = await shots.capture(kind, sourceId, {
        keepOwnerVisible: keepAppVisible && kind !== 'area',
        theme: kind === 'area' ? repositories.getSettings(defaults).theme : undefined,
      });
      if (!frame || epoch !== captureEpoch) { captureTimings.delete(captureId); return null; }
      markTiming(captureId, 'capture-complete');
      markTiming(captureId, 'optimization-start');
      const optimized = optimizeScreenImage(frame.image, {
        sourceName: frame.sourceName, maxBytes: config.screen.maxBytes, maxDimension: config.screen.maxDimension,
        scaleFactor: frame.scaleFactor,
      });
      markTiming(captureId, 'optimization-complete');
      if (config.debugMode) console.debug('[shot-image]', { captureId, kind, width: optimized.width, height: optimized.height,
        bytes: optimized.bytes.byteLength, mimeType: optimized.mimeType, resized: optimized.resized, preserveSmallText: optimized.preserveSmallText });
      const preview: ScreenCapturePreview = {
        id: captureId, sourceId: frame.sourceId, sourceName: frame.sourceName, capturedAt: frame.capturedAt,
        mimeType: optimized.mimeType, dataUrl: `data:${optimized.mimeType};base64,${optimized.bytes.toString('base64')}`,
        sizeBytes: optimized.bytes.byteLength, width: optimized.width, height: optimized.height, kind,
      };
      if (pendingCapture) captureTimings.delete(pendingCapture.preview.id);
      pendingCapture = { preview, optimizedImage: Promise.resolve(optimized) };
      // An area grant never silently becomes permission to capture its full monitor.
      if (kind !== 'area') selectedScreenSource = { id: frame.sourceId, name: frame.sourceName, kind };
      window.webContents.send(IPC.events, 'screen:capture-ready', preview);
      return preview;
    } catch (error) { captureTimings.delete(captureId); throw error; }
    finally { captureInProgress = false; }
  };
  ipcMain.handle(IPC.screen.captureDesktop, (_event, sourceId: string) => captureShot('screen', String(sourceId)));
  ipcMain.handle(IPC.screen.captureCurrent, () => {
    if (!selectedScreenSource) throw new Error('Choose a window or screen before analyzing the current screen.');
    return captureShot(selectedScreenSource.kind ?? 'screen', selectedScreenSource.id);
  });
  ipcMain.handle(IPC.screen.shot, (event, input: unknown) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unauthorized shot request.');
    const request = shotRequestSchema.parse(input);
    const sourceId = request.sourceId ?? (request.kind === 'tab' && selectedScreenSource?.kind === 'tab' ? selectedScreenSource.id : undefined);
    if (request.kind === 'tab' && !sourceId?.startsWith('window:')) throw new Error('Choose a browser or app window for Tab Shot.');
    if (request.kind !== 'area' && !sourceId) throw new Error('Choose a source for this shot.');
    return captureShot(request.kind, sourceId, request.keepAppVisible ?? false);
  });
  ipcMain.handle(IPC.screen.selectedSource, () => { requireAccess(); return selectedScreenSource; });
  ipcMain.handle(IPC.screen.approve, async (_event, captureId: string, sessionId: string, instruction: string, visibleQuestion?: string) => {
    requireAccess();
    assertProviderSetup(config, 'gemini');
    if (analysisInProgress) return { ok: false, error: 'Screen analysis is already running. Please wait for it to finish.' } as const;
    if (!repositories.getSession(sessionId)) return { ok: false, error: 'The selected interview session no longer exists.' } as const;
    const capture = pendingCapture?.preview.id === captureId ? pendingCapture : null;
    if (!capture) return { ok: false, error: 'This screenshot preview is no longer available.' } as const;
    markTiming(captureId, 'approval-start');
    const analysisAbort = new AbortController();
    approvedAbort = analysisAbort; analysisInProgress = true;
    try {
      const context = await interview.answerFromScreen({
        sessionId,
        captureId,
        question: String(instruction).slice(0, 5_000),
        displayQuestion: String(visibleQuestion ?? '').slice(0, 5_000),
        sourceName: capture.preview.sourceName,
        capturedAt: capture.preview.capturedAt,
        optimizedImage: capture.optimizedImage,
        analyzer: screenAnalyzer,
        signal: analysisAbort.signal,
        onTiming: (milestone) => markTiming(captureId, milestone),
      });
      pendingCapture = null; return { ok: true, context } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Screen analysis failed. Take another screenshot to retry.';
      // Keep analysis failures distinguishable from Chromium/WGC capture logs.
      // No screenshot bytes, task, session text, or credentials are logged.
      if (!analysisAbort.signal.aborted) console.warn('[screen-analysis] Failed', {
        captureId, model: screenAnalyzer.name, message: message.split(config.gemini.apiKey || '__no_key__').join('[REDACTED]').slice(0, 800),
      });
      return { ok: false, error: message } as const;
    } finally { analysisInProgress = false; approvedAbort = null; }
  });
  ipcMain.handle(IPC.screen.firstVisible, (_event, captureId: string) => { markTiming(String(captureId), 'first-visible'); });
  ipcMain.handle(IPC.screen.discard, () => {
    captureEpoch += 1;
    shots.cancel();
    approvedAbort?.abort(); approvedAbort = null;
    if (pendingCapture) captureTimings.delete(pendingCapture.preview.id);
    pendingCapture = null;
  });
  ipcMain.handle(IPC.screen.clearContext, () => { requireAccess(); return interview.setScreenContext(undefined); });
  const defaults: AppSettings = {
    theme: 'dark', overlayOpacity: 0.96, privateMode: true, debugMode: config.debugMode, demoMode: config.demoMode,
    shortcuts: { toggleOverlay: 'Live collapse button', pause: 'Ctrl+Shift+P', regenerate: 'Ctrl+Enter', copy: 'Ctrl+Shift+C' },
    geminiModel: config.gemini.model || undefined, deepgramModel: config.deepgram.model || undefined,
  };
  const initialSettings = repositories.getSettings(defaults);
  if (initialSettings.geminiModel && /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(initialSettings.geminiModel)) {
    config.gemini.model = initialSettings.geminiModel;
    models.setLocalDefault('gemini', initialSettings.geminiModel);
    if (config.isProduction || !process.env.SCREEN_GEMINI_MODEL) config.screen.model = initialSettings.geminiModel;
  }
  if (initialSettings.deepgramModel && /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/.test(initialSettings.deepgramModel)) {
    config.deepgram.model = initialSettings.deepgramModel;
    models.setLocalDefault('deepgram', initialSettings.deepgramModel);
  }
  // Renderer surfaces implement transparency without fading text or controls.
  if (process.platform === 'win32' || process.platform === 'darwin') window.setOpacity(1);
  window.setContentProtection(initialSettings.privateMode !== false);
  ipcMain.handle(IPC.settings.get, () => { requireAccess(); return repositories.getSettings(defaults); });
  ipcMain.handle(IPC.settings.save, async (_event, settings: unknown) => {
    requireAccess();
    const parsed = appSettingsSchema.parse(settings);
    await models.refresh();
    requireAccess();
    const current = repositories.getSettings(defaults);
    if (parsed.geminiModel && parsed.geminiModel !== current.geminiModel && !models.isAllowed('gemini', parsed.geminiModel)) throw new Error('The selected Gemini model is no longer enabled. Choose another model.');
    if (parsed.deepgramModel && parsed.deepgramModel !== current.deepgramModel && !models.isAllowed('deepgram', parsed.deepgramModel)) throw new Error('The selected Deepgram model is no longer enabled. Choose another model.');
    const safe = {
      ...parsed,
      debugMode: config.isProduction ? false : parsed.debugMode,
      demoMode: config.demoMode,
    };
    if (safe.geminiModel) {
      config.gemini.model = safe.geminiModel;
      models.setLocalDefault('gemini', safe.geminiModel);
      if (config.isProduction || !process.env.SCREEN_GEMINI_MODEL) config.screen.model = safe.geminiModel;
    }
    if (safe.deepgramModel) { config.deepgram.model = safe.deepgramModel; models.setLocalDefault('deepgram', safe.deepgramModel); }
    window.setContentProtection(safe.privateMode);
    return repositories.saveSettings(safe);
  });
  /** Removes everything registered above. The live work must already be stopped. */
  const dispose = (): void => {
    // Another workspace must never open inside the collapsed launcher-sized window.
    if (liveCollapsed && !window.isDestroyed()) setLiveCollapse(false);
    releaseOnClosed();
    window.removeListener('closed', releaseOnClosed);
    window.removeListener('close', preventClose);
    window.removeListener('minimize', keepRestored);
    window.webContents.removeListener?.('render-process-gone', releaseAssignmentMode);
    session.defaultSession.setDisplayMediaRequestHandler(null);
    ipcMain.dispose();
  };
  return { stopProtectedSession, dispose };
}
