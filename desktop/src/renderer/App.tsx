import { useEffect, useLayoutEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { FloatingLogo } from './components/FloatingLogo';
import { DiagonalResizeHandle } from './components/DiagonalResizeHandle';
import { WindowBar } from './components/WindowBar';
import { CopilotPage } from './pages/CopilotPage';
import { HistoryPage } from './pages/HistoryPage';
import { HomePage } from './pages/HomePage';
import {AccountCreditsSection} from './components/AccountCreditsSection';
import { FileLibraryPage } from './pages/FileLibraryPage';
import { SessionEditorPage } from './pages/SessionEditorPage';
import { SettingsPage } from './pages/SettingsPage';
import { useAppStore } from './stores/appStore';
import { AnswerStream } from './services/answerStream';
import { TranscriptOwnership } from './services/transcriptOwnership';
import { UpdatePage } from './pages/UpdatePage';
import type { UpdateStatus } from '../shared/types';
import type { AccountView } from '../shared/accounts';

export default function App({ account }: { account: AccountView }): JSX.Element {
  useEffect(()=>{
    if(!account)return;
    const reconnect=()=>{void window.accountAPI?.credits.refresh().catch(()=>undefined);};
    window.addEventListener('online',reconnect);
    return()=>window.removeEventListener('online',reconnect);
  },[account?.userId]);
  const page = useAppStore((s) => s.page);
  // Event handlers need stable actions, not a subscription to every streamed token.
  const store = useAppStore.getState();
  const theme = useAppStore((s) => s.settings?.theme ?? 'dark');
  const overlayOpacity = useAppStore((s) => s.settings?.overlayOpacity ?? .96);

  const [bridgeUnavailable, setBridgeUnavailable] = useState(false);
  const [dashboardCollapsed, setDashboardCollapsed] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [workspaceInitialized, setWorkspaceInitialized] = useState(false);

  /*
   * ============================================================
   * EXISTING DESKTOP BRIDGE INITIALIZATION
   * ============================================================
   */
  useEffect(() => {
    const api = window.electronAPI;

    if (!api) {
      setBridgeUnavailable(true);
      return undefined;
    }

    if (!api.bridgeVersion) {
      store.setError(
        'Desktop bridge loaded without a version handshake. Rebuild the preload.',
      );

      return undefined;
    }

    const answerStream = new AnswerStream(text => {
      if (answerStream.accepts(useAppStore.getState().activeAnswerId ?? '')) store.appendAnswer(text);
    });
    const transcriptOwnership = new TranscriptOwnership();
    let pendingCandidateTranscript: Parameters<typeof store.setTranscript>[0] | null = null;
    let candidateHandoffTimer: ReturnType<typeof setTimeout> | undefined;

    const clearCandidateHandoff = (): void => {
      pendingCandidateTranscript = null;
      if (candidateHandoffTimer) clearTimeout(candidateHandoffTimer);
      candidateHandoffTimer = undefined;
    };

    const handleTranscript = (data: Parameters<typeof store.setTranscript>[0]): void => {
      const claimNow = transcriptOwnership.shouldClaim(data);
      store.setTranscript(data, claimNow);

      if (data.sourceRole === 'remote_interviewer' && data.text.trim()) {
        clearCandidateHandoff();
        return;
      }
      if (data.sourceRole !== 'local_candidate') return;
      if (claimNow) {
        clearCandidateHandoff();
        return;
      }

      const delay = transcriptOwnership.candidateClaimDelay(data);
      if (delay === null) return;
      pendingCandidateTranscript = data;
      if (candidateHandoffTimer) clearTimeout(candidateHandoffTimer);
      candidateHandoffTimer = setTimeout(() => {
        const pending = pendingCandidateTranscript;
        candidateHandoffTimer = undefined;
        if (!pending || !transcriptOwnership.shouldClaim(pending)) return;
        pendingCandidateTranscript = null;
        store.claimTranscript(pending);
      }, delay + 1);
    };

    const cleanups = [
      api.onEvent(
        'copilot:status',
        (data) => {
          if (data.status === 'idle') {
            clearCandidateHandoff();
            transcriptOwnership.reset();
          }
          store.setCopilotStatus(
            data.status,
            data.message,
          );
        },
      ),

      api.onEvent(
        'transcript:partial',
        handleTranscript,
      ),

      api.onEvent(
        'transcript:final',
        handleTranscript,
      ),

      api.onEvent(
        'screen:capture-ready',
        (data) =>
          store.setScreenPreview(data),
      ),

      api.onEvent(
        'screen:context',
        (data) =>
          store.setScreenContext(data),
      ),

      api.onEvent(
        'question:detected',
        (data) =>
          store.setQuestion(data),
      ),

      api.onEvent(
        'question:resolved',
        (data) => store.resolveQuestion(data.questionId, data.question),
      ),

      api.onEvent(
        'answer:started',
        (data) => {
          answerStream.start(data.questionId);
          store.startAnswer(data.questionId, data.captureId);
        },
      ),

      api.onEvent(
        'answer:token',
        (data) => answerStream.push(data.questionId, data.token),
      ),

      api.onEvent(
        'answer:completed',
        (data) => {
          if (!answerStream.accepts(data.questionId) || useAppStore.getState().activeAnswerId !== data.questionId) return;
          answerStream.dispose();
          store.finishAnswer(
            data.answer.text,
            data.telemetry,
          );
        },
      ),

      api.onEvent(
        'app:error',
        (data) =>
          store.setError(
            `${data.title}: ${data.message}`,
          ),
      ),
    ];

    return () => {
      answerStream.dispose();
      clearCandidateHandoff();
      cleanups.forEach(
        (cleanup) => cleanup(),
      );
    };
  }, []);

  useEffect(() => {
    const authenticated = account.state === 'active';
    if (!authenticated || !updateStatus || updateStatus.state === 'required' || workspaceInitialized || !window.electronAPI) return;
    void Promise.all([
      window.electronAPI.listSessions(),
      window.electronAPI.getProviderStatus(),
      window.electronAPI.getSettings(),
    ]).then(([sessions, provider, settings]) => {
      store.setSessions(sessions);
      store.setProviderStatus(provider);
      store.setSettings(settings);
      document.documentElement.dataset.theme = settings.theme;
      setWorkspaceInitialized(true);
    }).catch((error: unknown) => store.setError(error instanceof Error ? error.message : 'Application initialization failed.'));
  }, [account.state, updateStatus?.state, workspaceInitialized]);

  useEffect(() => {
    if (account.state !== 'active' || !window.electronAPI) return undefined;
    let disposed = false;
    void window.electronAPI.getUpdateStatus().then((next) => { if (!disposed) setUpdateStatus(next); })
      .catch(() => { if (!disposed) setUpdateStatus({ state: 'unavailable', message: 'Update information is unavailable.' }); });
    const interval = window.setInterval(() => {
      void window.electronAPI.checkForUpdates().then((next) => { if (!disposed) setUpdateStatus(next); }).catch(() => undefined);
    }, 6 * 60 * 60 * 1_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [account.state]);

  /*
   * ============================================================
   * EXISTING THEME HANDLING
   * ============================================================
   */
  useEffect(() => {
    const preference = matchMedia('(prefers-color-scheme: light)');
    const applyTheme = (): void => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.colorScheme = theme === 'system'
        ? (preference.matches ? 'light' : 'dark') : theme;
    };
    applyTheme();
    preference.addEventListener('change', applyTheme);
    return () => preference.removeEventListener('change', applyTheme);
  }, [theme]);

  useLayoutEffect(() => {
    // Only surfaces fade: native/ancestor opacity would also fade every glyph.
    const opacity = Number.isFinite(overlayOpacity) ? Math.max(.35, Math.min(1, overlayOpacity)) : .96;
    document.documentElement.style.setProperty('--surface-opacity', String(opacity));
  }, [overlayOpacity]);

  useLayoutEffect(() => {
    if (dashboardCollapsed) document.documentElement.dataset.liveCollapsed = 'true';
    else delete document.documentElement.dataset.liveCollapsed;
    return () => { delete document.documentElement.dataset.liveCollapsed; };
  }, [dashboardCollapsed]);

  useEffect(() => {
    const focusEditableControl = (event: PointerEvent): void => {
      if (!(event.target instanceof Element)) return;
      const editable = event.target.closest<HTMLElement>('input, textarea, select, [contenteditable="true"]');
      if (!editable || editable.matches(':disabled')) return;
      if (document.activeElement !== editable) editable.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', focusEditableControl, true);
    return () => document.removeEventListener('pointerdown', focusEditableControl, true);
  }, []);

  const setDashboardCollapse = async (collapsed: boolean): Promise<void> => {
    const previous = dashboardCollapsed;
    setDashboardCollapsed(collapsed);
    // On collapse, do not paint a launcher-sized UI into the still-expanded
    // native window; that was the visible full-window blink. On restore, render
    // the full workspace while it is still clipped inside the small launcher.
    if (!collapsed) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await window.electronAPI.setLiveCollapsed(collapsed);
    } catch (error) {
      setDashboardCollapsed(previous);
      store.setError(error instanceof Error ? error.message : 'Could not change the window state.');
    }
  };

  /*
   * ============================================================
   * EXISTING DESKTOP BRIDGE ERROR
   * ============================================================
   */
  if (bridgeUnavailable) {
    return (
      <>
        <div className="startup-error">
          <h1>
            Desktop bridge unavailable
          </h1>

          <p>
            If this is{' '}
            <code>
              http://127.0.0.1:5173
            </code>{' '}
            in a browser, that is only
            the Vite renderer preview.
            Open the Electron window.
            Otherwise close the app, run{' '}
            <code>
              npm.cmd run build
            </code>
            , then{' '}
            <code>
              npm.cmd run start
            </code>
            .
          </p>
        </div>
      </>
    );
  }

  if (updateStatus?.state === 'required' && !updateStatus.sessionActive) return <UpdatePage account={Boolean(account)} status={updateStatus} onRetry={setUpdateStatus}/>;

  if (!updateStatus) return <div className="startup-error"><h1>Checking updates…</h1><p>Verifying the current release policy.</p></div>;

  if (!workspaceInitialized) return <div className="startup-error"><h1>Opening Cluera AI…</h1><p>Loading your local workspace.</p></div>;

  /*
   * ============================================================
   * EXISTING PAGE ROUTING
   * ============================================================
   */
  const content =
    page === 'home'
      ? <HomePage account={account} customerName={account.email} onCollapse={() => void setDashboardCollapse(true)} />
      : page === 'files'
        ? <FileLibraryPage onCollapse={() => void setDashboardCollapse(true)} />
      : page === 'create'
        ? <SessionEditorPage account={Boolean(account)} onCollapse={() => void setDashboardCollapse(true)} />
        : page === 'copilot'
          ? <CopilotPage />
          : page === 'history'
            ? <HistoryPage onCollapse={() => void setDashboardCollapse(true)} />
            : <SettingsPage account={account} onUpdateStatus={setUpdateStatus} />;

  const standaloneWorkspace = page === 'home' || page === 'create' || page === 'history' || page === 'files';

  return (
    <>
      {/* Collapse changes presentation, not the mounted page or its local draft. */}
      <div className={account ? 'app account-app' : 'app'} hidden={dashboardCollapsed}>
        {!standaloneWorkspace && <WindowBar onMinimize={() => void setDashboardCollapse(true)} />}

        <div
          className={`app-body ${
            page === 'copilot' || standaloneWorkspace
              ? 'focus'
              : ''
          }`}
        >
          {!standaloneWorkspace && page !== 'copilot' && (
            <Sidebar />
          )}

          <div className={`content${account && page === 'copilot' ? ' account-live-content' : ''}`}>
            {account&&page==='copilot'&&<AccountCreditsSection key={account.userId} userId={account.userId} compact/>}
            {content}
          </div>
        </div>
        {page !== 'copilot' && <DiagonalResizeHandle />}
      </div>
      {dashboardCollapsed && <FloatingLogo label="Restore Cluera AI dashboard" onRestore={() => void setDashboardCollapse(false)}/>}
    </>
  );
}
