import {
  AudioLines, Check, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Edit3,
  LogOut, MessageCircle, MoreHorizontal, Move, Play, Settings2, SlidersHorizontal, Sparkles,
  Square, Star, SunMedium, WandSparkles, X, Crop, Camera, Mic, Minimize2, Send,
  ZoomIn, ZoomOut,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { AudioSourceDescriptor, DesktopCaptureSource, ScreenCapturePreview, SessionDetail, ShotKind } from '../../shared/types';
import { FormattedAnswer } from '../components/FormattedAnswer';
import { FloatingLogo } from '../components/FloatingLogo';
import { ThemeControl } from '../components/ThemeControl';
import { PrivateModeControl } from '../components/PrivateModeControl';
import {
  AudioCapture, isAutomaticMicrophoneAlias, selectAutomaticMicrophone, selectAutomaticSystemAudioSource, type MicrophoneDevice,
} from '../services/audioCapture';
import { qaFontResizeDelta, renderedAnswerLineHeight } from '../services/answerScroll';
import { estimateReadingProgress } from '../services/readingProgress';
import { EyeContactScroll, ReadingFocus, type ReadingState } from '../services/eyeContactScroll';
import { ManualQuestionOwnership } from '../services/manualQuestionOwnership';
import { qaNavigationDelta } from '../services/qaNavigationShortcuts';
import { useAppStore } from '../stores/appStore';

const SYSTEM_SOURCE: AudioSourceDescriptor = {
  id: 'electron-system-audio',
  kind: 'system',
  role: 'remote_interviewer',
  label: 'Participant audio output',
  canTriggerAnswers: true,
};

const statusLabels: Record<string, string> = {
  idle: 'Ready',
  preparing: 'Preparing',
  listening: 'Listening',
  'question-detected': 'Question detected',
  retrieving: 'Finding context',
  answering: 'Writing answer',
  ready: 'Answer ready',
  paused: 'Paused',
  recovering: 'Recovering',
  error: 'Error',
};

const AUTOMATIC_SCREEN_INSTRUCTION = 'This screenshot is from an interview screen shared by the interviewer. Read and understand the visible text, code, error, diagram, question, terminal output, document, or other task. Infer what the interviewer is asking from the screenshot and current interview conversation. Use relevant session context, resume, job description, and retrieved supporting context when useful. Then generate the best direct interview answer for the candidate without asking for another screenshot instruction.';
const SCREEN_QUESTION_FALLBACK = 'Answer the question detected from the screenshot';
type MicrophoneMode = 'auto' | 'manual' | 'off';
type AnswerStyleMode = 'shorter' | 'longer' | 'technical' | 'conversational' | 'star';

const ANSWER_STYLES: Array<{ label: string; mode: AnswerStyleMode }> = [
  { label: 'Natural', mode: 'conversational' },
  { label: 'Shorter Answer', mode: 'shorter' },
  { label: 'Expand Answer', mode: 'longer' },
  { label: 'More Technical', mode: 'technical' },
  { label: 'Use STAR', mode: 'star' },
];

function formatSessionTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function CopilotPage(): JSX.Element {
  const store = useAppStore();
  const activeId = store.activeSessionId;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [manual, setManual] = useState('');
  const [transcriptDraftActive, setTranscriptDraftActive] = useState(false);
  const [running, setRunning] = useState(false);
  const [sessionElapsedSeconds, setSessionElapsedSeconds] = useState(0);
  const [deviceCheckActive, setDeviceCheckActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [questionCopied, setQuestionCopied] = useState(false);
  const [desktopSources, setDesktopSources] = useState<DesktopCaptureSource[]>([]);
  const [showSources, setShowSources] = useState(false);
  const [pickerPurpose, setPickerPurpose] = useState<'screen' | 'tab'>('screen');
  const pickerKeepAppVisible = useRef(false);
  const [systemSourceId, setSystemSourceId] = useState(() => localStorage.getItem('sigmaround.systemAudio.sourceId') ?? '');
  const [systemSourceName, setSystemSourceName] = useState(() => localStorage.getItem('sigmaround.systemAudio.sourceName') ?? 'Automatic Windows output');
  const [systemAudioStatus, setSystemAudioStatus] = useState<'idle' | 'starting' | 'active' | 'error'>('idle');
  const [analyzingScreen, setAnalyzingScreen] = useState(false);
  const [screenStreaming, setScreenStreaming] = useState(false);
  const [selectedScreenSourceName, setSelectedScreenSourceName] = useState<string | null>(null);
  const [selectedShot, setSelectedShot] = useState<{ id: string; kind: ShotKind } | null>(null);
  const [capturingShot, setCapturingShot] = useState(false);
  const shotBusy = useRef(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [showLiveMenu, setShowLiveMenu] = useState(false);
  const [qaFontSize, setQaFontSize] = useState(13);
  const [showAnswerStyle, setShowAnswerStyle] = useState(false);
  const [answerStyleLabel, setAnswerStyleLabel] = useState('Natural');
  const [autoAnswerEnabled, setAutoAnswerEnabled] = useState(() => store.sessions.find((session) => session.id === activeId)?.autoAnswer ?? false);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(false);
  const readingController = useRef<EyeContactScroll | null>(null);
  const readingFocus = useRef(new ReadingFocus());
  const manualViewport = useRef(0);
  const [questionDraft, setQuestionDraft] = useState('');
  const [answerRequestPending, setAnswerRequestPending] = useState(false);
  const topQuestionSending = useRef(false);
  const manualSendShortcut = useRef<(event: KeyboardEvent) => void>(() => {});
  const [collapsed, setCollapsed] = useState(false);
  const [microphones, setMicrophones] = useState<MicrophoneDevice[]>([]);
  const [showMicrophones, setShowMicrophones] = useState(false);
  // Each newly opened live session begins on Windows System default. Explicit
  // selections still apply immediately for the rest of that live session.
  const [microphoneMode, setMicrophoneMode] = useState<MicrophoneMode>('auto');
  const [microphoneDeviceId, setMicrophoneDeviceId] = useState(() => localStorage.getItem('sigmaround.microphone.deviceId') ?? '');
  const [microphoneLabel, setMicrophoneLabel] = useState(() => localStorage.getItem('sigmaround.microphone.label') ?? 'Automatic microphone');
  const [microphoneStatus, setMicrophoneStatus] = useState<'idle' | 'starting' | 'active' | 'disabled' | 'error'>('idle');
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const audio = useRef(new AudioCapture('system'));
  const candidateAudio = useRef(new AudioCapture('candidate'));
  const answerPanelRef = useRef<HTMLDivElement>(null);
  const qaContentRef = useRef<HTMLDivElement>(null);
  const liveWidgetRef = useRef<HTMLElement>(null);
  const qaPanelRef = useRef<HTMLElement>(null);
  const transcriptComposerRef = useRef<HTMLFormElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);
  const questionEditorRef = useRef<HTMLTextAreaElement>(null);
  const questionOwnership = useRef(new ManualQuestionOwnership());
  const transcriptFocusInteractionActiveRef = useRef(false);
  const questionFocusEpoch = useRef(0);
  const transcriptDraftBaseline = useRef('');
  const transcriptDraftReleaseArmed = useRef(false);
  const transcriptDraftEditedRef = useRef(false);
  const transcriptSubmission = useRef(0);
  const answerRequestEpoch = useRef(0);
  const answerRequestBaselineId = useRef<string | null>(null);
  const deviceCheckPromise = useRef<Promise<boolean> | null>(null);
  const preparedSessionId = useRef<string | null>(null);
  const unmountCleanupTimer = useRef<number | null>(null);
  const autoFocusingTranscript = useRef(false);
  const activeScreenCaptureId = useRef<string | null>(null);
  const firstScreenChunkReported = useRef(false);
  const microphoneEpoch = useRef(0);
  const audioOutputSignature = useRef('');
  const readingPositions = useRef(new Map<string, number>());
  const liveMenuRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const answerStyleMenuRef = useRef<HTMLDivElement>(null);
  const answerStyleButtonRef = useRef<HTMLButtonElement>(null);
  const liveResizeDrag = useRef<{ pointerId: number; startX: number; startY: number } | null>(null);
  const qaResizeDrag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const sessionElapsedBeforeRun = useRef(0);
  const sessionRunStartedAt = useRef<number | null>(null);
  const [qaPanelHeight, setQaPanelHeight] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;
    if (activeId) void window.electronAPI.getSession(activeId).then((next) => {
      if (disposed) return;
      setDetail(next);
      const enabled = next?.session.autoAnswer ?? false;
      setAutoAnswerEnabled(enabled);
      void window.electronAPI.setAutoAnswer(enabled).catch(() => undefined);
    }).catch((error: unknown) => store.setError(error instanceof Error ? error.message : 'Could not load session preferences.'));
    return () => { disposed = true; };
  }, [activeId]);

  useEffect(() => {
    void window.electronAPI.getSelectedScreenSource().then((source) => {
      setSelectedScreenSourceName(source?.name ?? null);
      setSelectedShot(source ? { id: source.id, kind: source.kind ?? 'screen' } : null);
    });
  }, []);

  useEffect(() => {
    if (!analyzingScreen || !store.answer || !activeScreenCaptureId.current || store.answerCaptureId !== activeScreenCaptureId.current || firstScreenChunkReported.current) return;
    setScreenStreaming(true);
    firstScreenChunkReported.current = true;
    const captureId = activeScreenCaptureId.current;
    requestAnimationFrame(() => { void window.electronAPI.reportScreenAnswerVisible(captureId); });
  }, [analyzingScreen, store.answer, store.answerCaptureId]);

  useEffect(() => {
    // Cancel React Strict Mode's development-only teardown when its immediate
    // remount occurs. A genuine page exit receives no remount and still closes
    // every native capture/provider resource on the next task.
    if (unmountCleanupTimer.current !== null) {
      window.clearTimeout(unmountCleanupTimer.current);
      unmountCleanupTimer.current = null;
    }
    return () => {
      unmountCleanupTimer.current = window.setTimeout(() => {
        delete document.documentElement.dataset.copilotSession;
        delete document.documentElement.dataset.liveSession;
        void audio.current.stop();
        void candidateAudio.current.stop();
        void window.electronAPI.setLiveCollapsed(false);
        void window.electronAPI.stopInterview();
        unmountCleanupTimer.current = null;
      }, 0);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.copilotSession = 'true';
    void window.electronAPI.setSessionWindowMode(true);
    return () => {
      delete document.documentElement.dataset.copilotSession;
      void window.electronAPI.setSessionWindowMode(false);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.liveSession = 'true';
    return () => { delete document.documentElement.dataset.liveSession; };
  }, []);

  useLayoutEffect(() => {
    if (collapsed) document.documentElement.dataset.liveCollapsed = 'true';
    else delete document.documentElement.dataset.liveCollapsed;
    return () => { delete document.documentElement.dataset.liveCollapsed; };
  }, [collapsed]);

  useEffect(() => {
    if (collapsed) return undefined;
    const navigateQa = (event: KeyboardEvent): void => {
      const target = event.target;
      const isEditableElement = target instanceof HTMLElement && Boolean(
        target.isContentEditable || target.closest('input, textarea, select, [contenteditable]'),
      );
      // The live transcript composer is intentionally auto-focused so Enter is
      // always ready. That passive focus must not block Q&A shortcuts; only a
      // draft the user has actually edited should protect text entry.
      const editableTarget = isEditableElement
        && (target !== manualInputRef.current || transcriptDraftEditedRef.current);
      const delta = qaNavigationDelta(event, editableTarget);
      if (!delta) return;
      event.preventDefault();
      const state = useAppStore.getState();
      const nextIndex = state.activeQaIndex + delta;
      if (nextIndex >= 0 && nextIndex < state.liveQaItems.length) state.selectQa(nextIndex);
    };
    window.addEventListener('keydown', navigateQa, true);
    return () => window.removeEventListener('keydown', navigateQa, true);
  }, [collapsed]);

  useEffect(() => {
    if (!showLiveMenu) return undefined;
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (liveMenuRef.current?.contains(target) || moreButtonRef.current?.contains(target)) return;
      setShowLiveMenu(false);
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setShowLiveMenu(false); };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', escape);
    };
  }, [showLiveMenu]);

  useEffect(() => {
    if (!showAnswerStyle) return undefined;
    const dismiss = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (answerStyleMenuRef.current?.contains(target) || answerStyleButtonRef.current?.contains(target)) return;
      setShowAnswerStyle(false);
    };
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setShowAnswerStyle(false); };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', escape);
    };
  }, [showAnswerStyle]);

  const activeQa = store.activeQaIndex >= 0 ? store.liveQaItems[store.activeQaIndex] : undefined;
  const currentInterviewerInteraction = store.pendingInterviewerTranscript.trim();
  const displayedQuestion = currentInterviewerInteraction || activeQa?.question?.question || store.question?.question || store.transcript || 'Waiting for the interviewer question...';
  const displayedAnswer = activeQa?.answer ?? store.answer;
  const displayedTelemetry = activeQa?.telemetry ?? store.telemetry;
  const generatingAnswer = answerRequestPending
    || Boolean(activeQa?.streaming)
    || store.copilotStatus === 'question-detected'
    || store.copilotStatus === 'retrieving';

  useEffect(() => {
    if (answerRequestPending && store.activeAnswerId !== answerRequestBaselineId.current) {
      setAnswerRequestPending(false);
    }
  }, [answerRequestPending, store.activeAnswerId]);
  const hasDisplayedQuestion = Boolean(currentInterviewerInteraction || activeQa?.question?.question || store.question?.question || store.transcript.trim());
  const currentQuestion = activeQa?.question?.question ?? store.question?.question ?? manual;
  const latency = useMemo(() => displayedTelemetry
    ? `${(displayedTelemetry.totalQuestionToAnswerLatency / 1000).toFixed(1)}s · ${displayedTelemetry.llmTimeToFirstToken}ms first token`
    : '', [displayedTelemetry]);
  const activeTranscriptRole = store.activeTranscriptRole;
  const activeSpeaker = activeTranscriptRole === 'candidate' ? 'You' : 'Interviewer';
  const activeTranscriptText = store.activeTranscript.trim();
  const candidateDeviceSettled = microphoneMode === 'off'
    || microphoneStatus === 'active'
    || microphoneStatus === 'disabled'
    || microphoneStatus === 'error';
  const deviceCheckReady = deviceCheckActive && systemAudioStatus === 'active' && candidateDeviceSettled;
  const deviceDetectionInProgress = !deviceCheckReady && systemAudioStatus !== 'error';
  const preStartAnswerMessage = systemAudioStatus === 'error'
    ? 'Audio output needs attention. Use the speaker control to reconnect it.'
    : deviceDetectionInProgress
      ? 'Detecting microphone and audio output'
      : 'Devices ready. You can start the round now.';
  const sessionTimer = formatSessionTime(sessionElapsedSeconds);

  useEffect(() => {
    sessionElapsedBeforeRun.current = 0;
    sessionRunStartedAt.current = null;
    setSessionElapsedSeconds(0);
  }, [activeId]);

  useEffect(() => {
    if (!running) return undefined;
    if (sessionRunStartedAt.current === null) sessionRunStartedAt.current = Date.now();
    const updateTimer = (): void => {
      const startedAt = sessionRunStartedAt.current;
      if (startedAt === null) return;
      setSessionElapsedSeconds(Math.floor((sessionElapsedBeforeRun.current + Date.now() - startedAt) / 1000));
    };
    updateTimer();
    const timer = window.setInterval(updateTimer, 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  const transcriptInputValue = transcriptDraftActive ? manual : activeTranscriptText;
  const transcriptAnswerText = transcriptDraftActive ? manual.trim() : activeTranscriptText;

  const focusQuestionEditorAtEnd = (moveCaret = true): void => {
    const editor = questionEditorRef.current;
    if (!editor) return;
    const wasFocused = document.activeElement === editor;
    editor.focus({ preventScroll: true });
    if (moveCaret || !wasFocused) editor.setSelectionRange(editor.value.length, editor.value.length);
  };

  const fitQuestionEditor = (): void => {
    const editor = questionEditorRef.current;
    if (!editor) return;
    editor.style.height = 'auto';
    editor.style.height = `${editor.scrollHeight}px`;
  };

  useLayoutEffect(() => {
    if (autoAnswerEnabled) {
      questionOwnership.current.reset();
      questionFocusEpoch.current += 1;
      return;
    }
    if (collapsed) {
      questionFocusEpoch.current += 1;
      return;
    }
    const editor = questionEditorRef.current;
    if (!editor) return;
    const interactionActive = Boolean(currentInterviewerInteraction);
    const { startsNewTurn: startsNewInteraction, acceptTranscript } = questionOwnership.current.observe(
      store.interviewerTurnSequence, interactionActive,
    );

    // Reclaim keyboard focus once when a new manual-answer interaction starts.
    // Repeating native focus calls for every partial word steals focus from the
    // browser/file picker and can create a large queue of redundant IPC work.
    const transcriptNeedsFocus = startsNewInteraction;
    if (transcriptNeedsFocus) {
      const focusEpoch = ++questionFocusEpoch.current;
      const focusEditor = async (): Promise<void> => {
        focusQuestionEditorAtEnd(true);
        for (const delayMs of [0, 80]) {
          if (delayMs) await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
          if (questionFocusEpoch.current !== focusEpoch) return;
          try { await window.electronAPI.focusLiveTranscript(true); } catch { /* The remaining local retries are safe. */ }
          if (questionFocusEpoch.current !== focusEpoch) return;
          focusQuestionEditorAtEnd(true);
          if (document.hasFocus() && document.activeElement === questionEditorRef.current) return;
        }
      };
      void focusEditor();
    }

    const nextText = hasDisplayedQuestion ? displayedQuestion : '';
    if (acceptTranscript && questionDraft !== nextText) setQuestionDraft(nextText);
  }, [autoAnswerEnabled, collapsed, currentInterviewerInteraction, store.interviewerTurnSequence, displayedQuestion, hasDisplayedQuestion, questionDraft]);

  useLayoutEffect(() => {
    if (autoAnswerEnabled || collapsed || !questionEditorRef.current) return;
    fitQuestionEditor();
  }, [autoAnswerEnabled, collapsed, questionDraft]);

  useEffect(() => {
    if (autoAnswerEnabled || collapsed || !questionEditorRef.current) return undefined;
    window.addEventListener('resize', fitQuestionEditor);
    return () => window.removeEventListener('resize', fitQuestionEditor);
  }, [autoAnswerEnabled, collapsed]);

  useEffect(() => {
    if (!transcriptDraftActive || !transcriptDraftReleaseArmed.current) return;
    if (activeTranscriptText && activeTranscriptText !== transcriptDraftBaseline.current) {
      transcriptDraftReleaseArmed.current = false;
      transcriptDraftEditedRef.current = false;
      setTranscriptDraftActive(false);
      setManual('');
    }
  }, [activeTranscriptText, transcriptDraftActive]);

  useLayoutEffect(() => {
    const input = manualInputRef.current;
    if (!input || transcriptDraftActive) return;
    input.scrollLeft = input.scrollWidth;
    if (!transcriptInputValue) return;
    // Manual answering mode is display-only until the user explicitly clicks
    // the composer. Continue showing and horizontally following transcript
    // updates, but never steal focus from the meeting application.
    if (!autoAnswerEnabled) return;
    const interviewerInteractionActive = activeTranscriptRole === 'interviewer'
      && Boolean(currentInterviewerInteraction);
    const shouldActivateWindow = interviewerInteractionActive
      && !transcriptFocusInteractionActiveRef.current;
    transcriptFocusInteractionActiveRef.current = interviewerInteractionActive;
    if (activeTranscriptRole === 'interviewer' && !shouldActivateWindow) return;
    let cancelled = false;
    const focusInput = async (): Promise<void> => {
      // document.activeElement can still be this input while another desktop
      // application owns keyboard focus. Activate Cluera AI first for incoming
      // interviewer speech so Enter works immediately without an extra click.
      if (shouldActivateWindow) {
        try { await window.electronAPI.focusLiveTranscript(); } catch { /* The local focus below remains a safe fallback. */ }
      } else if (document.activeElement === input) {
        return;
      }
      if (cancelled) return;
      autoFocusingTranscript.current = true;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      autoFocusingTranscript.current = false;
    };
    void focusInput();
    return () => { cancelled = true; };
  }, [transcriptInputValue, transcriptDraftActive, store.activeTranscriptRole, autoAnswerEnabled, currentInterviewerInteraction]);
  const readingProgress = useMemo(() => {
    if (collapsed || !activeQa) return estimateReadingProgress('', '');
    if (readingPositions.current.size > 50) {
      const retained = new Set(store.liveQaItems.map(item => item.questionId));
      for (const id of readingPositions.current.keys()) if (!retained.has(id)) readingPositions.current.delete(id);
    }
    const previous = readingPositions.current.get(activeQa.questionId) ?? -1;
    const progress = estimateReadingProgress(displayedAnswer, `${store.candidateReadingTranscript} ${store.candidateTranscript}`, previous);
    if (progress.currentWordIndex >= previous) readingPositions.current.set(activeQa.questionId, progress.currentWordIndex);
    return progress;
  }, [collapsed, activeQa?.questionId, store.activeAnswerId, displayedAnswer, store.candidateReadingTranscript, store.candidateTranscript]);

  useLayoutEffect(() => {
    if (collapsed || !answerPanelRef.current || !qaContentRef.current) return;
    const controller = new EyeContactScroll(answerPanelRef.current, qaContentRef.current, readingFocus.current);
    readingController.current = controller;
    if (!autoScrollEnabled && manualViewport.current > 0) {
      qaContentRef.current.style.minHeight = `${manualViewport.current + answerPanelRef.current.clientHeight}px`;
      answerPanelRef.current.scrollTop = manualViewport.current;
    }
    return () => { controller.dispose(); readingController.current = null; };
  }, [collapsed]);

  useLayoutEffect(() => {
    const state: ReadingState = {
      enabled: autoScrollEnabled, hidden: collapsed, turn: store.interviewerTurnSequence,
      questionId: activeQa?.questionId, hasAnswer: Boolean(displayedAnswer),
      pendingQuestion: Boolean(currentInterviewerInteraction) || store.interviewerSpeaking,
      speaking: store.interviewerSpeaking, submitting: answerRequestPending, word: readingProgress.currentWordIndex,
    };
    if (readingController.current) readingController.current.update(state);
    else readingFocus.current.update(state); // retain ownership while the collapsed DOM is absent
  }, [autoScrollEnabled, collapsed, store.interviewerTurnSequence, activeQa?.questionId,
    Boolean(displayedAnswer), Boolean(currentInterviewerInteraction), store.interviewerSpeaking,
    answerRequestPending, readingProgress.currentWordIndex]);

  const holdManualScroll = (): void => { readingController.current?.hold(); };
  const preserveManualScrollExtent = (): void => {
    const panel = answerPanelRef.current;
    const content = qaContentRef.current;
    if (!autoScrollEnabled && panel && content) {
      manualViewport.current = panel.scrollTop;
      // Keep the scroll range when a long answer is replaced by a short one.
      // Otherwise Chromium clamps scrollTop even with all effects disabled.
      const minimum = panel.scrollTop + panel.clientHeight;
      if (minimum > (Number.parseFloat(content.style.minHeight) || 0)) content.style.minHeight = `${minimum}px`;
    }
  };
  const toggleAutoScroll = (): void => {
    const panel = answerPanelRef.current;
    if (autoScrollEnabled && panel && qaContentRef.current) {
      manualViewport.current = panel.scrollTop;
      qaContentRef.current.style.minHeight = `${panel.scrollHeight}px`;
      panel.scrollTo({ top: panel.scrollTop, behavior: 'instant' }); // cancel an in-flight smooth scroll
    }
    holdManualScroll();
    setAutoScrollEnabled(enabled => !enabled);
  };

  const scrollAnswer = (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.defaultPrevented || showLiveMenu || showSources || showMicrophones || store.screenPreview) return;
      if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp')
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable
        || target.closest('input, textarea, select, [contenteditable], button, a, [role="menu"]'))) return;
      const panel = answerPanelRef.current;
      if (!panel || !displayedAnswer || panel.scrollHeight <= panel.clientHeight + 1) return;
      const answerContent = panel.querySelector<HTMLElement>('.answer-copy .answer-rich') ?? panel;
      const lineHeight = renderedAnswerLineHeight(window.getComputedStyle(answerContent));
      event.preventDefault();
      holdManualScroll();
      panel.scrollBy({ top: (event.key === 'ArrowDown' ? 1 : -1) * lineHeight, behavior: 'smooth' });
  };

  const chooseDesktop = async (purpose: 'screen' | 'tab', keepAppVisible = false): Promise<void> => {
    try {
      setShowLiveMenu(false);
      setPickerPurpose(purpose);
      pickerKeepAppVisible.current = keepAppVisible;
      const sources = await window.electronAPI.listDesktopCaptureSources();
      setDesktopSources(purpose === 'tab' ? sources.filter(item => item.id.startsWith('window:')) : sources);
      setShowSources(true);
    } catch (error) {
      store.setError(error instanceof Error ? error.message : 'Could not list windows and screens.');
    }
  };

  const retainSystemAudioSource = (sourceId: string, sourceName: string): void => {
    setSystemSourceId(sourceId);
    setSystemSourceName(sourceName);
    localStorage.setItem('sigmaround.systemAudio.sourceId', sourceId);
    localStorage.setItem('sigmaround.systemAudio.sourceName', sourceName);
  };

  const ensureAutomaticSystemAudioSource = async (): Promise<void> => {
    const sources = await window.electronAPI.listDesktopCaptureSources();
    const selected = selectAutomaticSystemAudioSource(sources)
      ?? sources.find((source) => source.id === systemSourceId);
    if (!selected) throw new Error('No system audio output capture source is available.');
    const selectedName = await window.electronAPI.selectSystemAudioSource(selected.id);
    retainSystemAudioSource(selected.id, `Windows output · ${selectedName}`);
  };

  const reconnectSystemAudio = async (): Promise<void> => {
    setShowLiveMenu(false);
    setSystemAudioStatus('starting');
    try {
      if (!deviceCheckActive) {
        const ready = await prepareDeviceCheck();
        if (!ready) throw new Error('Audio device checking could not be prepared.');
      }
      await ensureAutomaticSystemAudioSource();
      await audio.current.start();
      try { audioOutputSignature.current = await AudioCapture.audioOutputSignature(); } catch { /* Device labels may be permission-gated. */ }
      setSystemAudioStatus('active');
      store.setError(null);
    } catch (error) {
      setSystemAudioStatus('error');
      store.setError(error instanceof Error ? error.message : 'Could not reconnect Windows audio output.');
    }
  };

  const activateCandidateMicrophone = async (mode: MicrophoneMode, requestedDeviceId = ''): Promise<void> => {
    const epoch = ++microphoneEpoch.current;
    setMicrophoneError(null);
    store.clearCandidateTranscript();
    if (mode === 'off') {
      await candidateAudio.current.stop();
      if (microphoneEpoch.current !== epoch) return;
      setMicrophoneLabel('No candidate microphone');
      setMicrophoneStatus('disabled');
      return;
    }

    setMicrophoneStatus('starting');
    try {
      let chosenDeviceId = requestedDeviceId;
      if (mode === 'auto') {
        const available = await AudioCapture.listMicrophones();
        if (microphoneEpoch.current !== epoch) return;
        setMicrophones(available);
        const automatic = selectAutomaticMicrophone(available);
        if (!automatic) throw new Error('No usable physical microphone input was found.');
        // Let Chromium resolve Windows' current default input rather than
        // pinning the pseudo "default" endpoint as an exact physical device.
        chosenDeviceId = automatic.deviceId === 'default' ? '' : automatic.deviceId;
      }
      const selected = await candidateAudio.current.start(chosenDeviceId || undefined);
      if (microphoneEpoch.current !== epoch) return;
      const selectedLabel = mode === 'auto' ? `System default · ${selected.label}` : selected.label;
      setMicrophoneLabel(selectedLabel);
      setMicrophoneDeviceId(selected.deviceId);
      localStorage.setItem('sigmaround.microphone.deviceId', selected.deviceId);
      localStorage.setItem('sigmaround.microphone.label', selectedLabel);
      setMicrophoneStatus('active');
    } catch (error) {
      if (microphoneEpoch.current !== epoch) return;
      setMicrophoneStatus('error');
      setMicrophoneError(`${error instanceof Error ? error.message : 'Candidate microphone could not start.'} The meeting is still listening without candidate audio.`);
    }
  };

  const prepareDeviceCheck = (): Promise<boolean> => {
    if (!activeId || !store.providerStatus?.deepgramConfigured) return Promise.resolve(false);
    if (deviceCheckActive && preparedSessionId.current === activeId) return Promise.resolve(true);
    if (deviceCheckPromise.current) return deviceCheckPromise.current;

    const sessionId = activeId;
    const task = (async (): Promise<boolean> => {
      try {
        store.setError(null);
        if (preparedSessionId.current && preparedSessionId.current !== sessionId) {
          microphoneEpoch.current += 1;
          await Promise.all([audio.current.stop(), candidateAudio.current.stop(), window.electronAPI.stopInterview()]);
          setDeviceCheckActive(false);
        }
        transcriptDraftReleaseArmed.current = false;
        transcriptDraftEditedRef.current = false;
        setTranscriptDraftActive(false);
        setManual('');
        store.clearDeviceCheckTranscript();
        setSystemAudioStatus('starting');
        await window.electronAPI.setAutoAnswer(autoAnswerEnabled);
        await window.electronAPI.startInterview(sessionId, SYSTEM_SOURCE, false);
        preparedSessionId.current = sessionId;
        setDeviceCheckActive(true);

        let outputError: unknown;
        try {
          await ensureAutomaticSystemAudioSource();
          await audio.current.start();
          try { audioOutputSignature.current = await AudioCapture.audioOutputSignature(); } catch { /* Device labels may be permission-gated. */ }
          setSystemAudioStatus('active');
        } catch (error) {
          outputError = error;
          setSystemAudioStatus('error');
        }

        // Candidate capture is independently optional, so a missing microphone
        // never prevents the output-audio device check (and vice versa).
        void activateCandidateMicrophone(microphoneMode, microphoneDeviceId);
        if (outputError) store.setError(outputError instanceof Error ? outputError.message : 'Could not start the audio-output device check.');
        return true;
      } catch (error) {
        preparedSessionId.current = null;
        setDeviceCheckActive(false);
        setSystemAudioStatus('error');
        await window.electronAPI.stopInterview();
        store.setError(error instanceof Error ? error.message : 'Could not prepare audio device checking.');
        return false;
      }
    })();
    deviceCheckPromise.current = task;
    void task.finally(() => {
      if (deviceCheckPromise.current === task) deviceCheckPromise.current = null;
    });
    return task;
  };

  const start = async (): Promise<void> => {
    if (!store.providerStatus?.deepgramConfigured) {
      store.setError('Add your Deepgram API key in Settings before starting live audio. Typed questions still work without it.');
      return;
    }
    try {
      const ready = await prepareDeviceCheck();
      if (!ready) return;
      // Device-check speech is intentionally transient. Start begins a clean
      // interview context without reconnecting either live audio stream.
      transcriptDraftReleaseArmed.current = false;
      transcriptDraftEditedRef.current = false;
      setTranscriptDraftActive(false);
      setManual('');
      store.clearDeviceCheckTranscript();
      await window.electronAPI.setAutoAnswer(autoAnswerEnabled);
      await window.electronAPI.setInterviewInteractionEnabled(true);
      setRunning(true);
    } catch (error) {
      store.setError(error instanceof Error ? error.message : 'Could not enable AI interaction.');
    }
  };

  const pauseSessionTimer = (): void => {
    const startedAt = sessionRunStartedAt.current;
    if (startedAt === null) return;
    sessionElapsedBeforeRun.current += Date.now() - startedAt;
    sessionRunStartedAt.current = null;
    setSessionElapsedSeconds(Math.floor(sessionElapsedBeforeRun.current / 1000));
  };

  const stop = async (): Promise<void> => {
    pauseSessionTimer();
    setRunning(false);
    await window.electronAPI.setInterviewInteractionEnabled(false);
    transcriptDraftReleaseArmed.current = false;
    transcriptDraftEditedRef.current = false;
    setTranscriptDraftActive(false);
    setManual('');
    store.clearDeviceCheckTranscript();
    setShowLiveMenu(false);
  };

  const endSession = async (destination: 'home' | 'settings' = 'home'): Promise<void> => {
    pauseSessionTimer();
    setShowLiveMenu(false);
    setShowAnswerStyle(false);
    setRunning(false);
    const pendingPreparation = deviceCheckPromise.current;
    if (pendingPreparation) await pendingPreparation.catch(() => false);
    microphoneEpoch.current += 1;
    preparedSessionId.current = null;
    setDeviceCheckActive(false);
    await Promise.allSettled([audio.current.stop(), candidateAudio.current.stop()]);
    await Promise.allSettled([window.electronAPI.stopInterview(), window.electronAPI.setLiveCollapsed(false)]);
    setSystemAudioStatus('idle');
    setMicrophoneStatus(microphoneMode === 'off' ? 'disabled' : 'idle');
    store.resetCopilot();
    store.setPage(destination);
  };
  const openProviderSettings = (): void => {
    if ((running || deviceCheckActive) && !window.confirm('Opening AI provider settings ends this live session. Continue?')) return;
    void endSession('settings');
  };

  useEffect(() => {
    if (!activeId || !store.providerStatus?.deepgramConfigured) return;
    // React Strict Mode performs a setup/cleanup/setup probe in development.
    // Scheduling preparation lets the probe cleanup cancel the first attempt,
    // so it cannot tear down the real second Device Check after it connects.
    const timer = window.setTimeout(() => { void prepareDeviceCheck(); }, 0);
    return () => window.clearTimeout(timer);
  }, [activeId, store.providerStatus?.deepgramConfigured]);

  const chooseMicrophone = async (): Promise<void> => {
    setShowLiveMenu(false);
    setMicrophoneError(null);
    setShowMicrophones(true);
    try {
      const available = await AudioCapture.listMicrophones();
      setMicrophones(available);
      if (!available.length) setMicrophoneError('No microphone devices were found. You can continue without candidate audio.');
    } catch (error) {
      setMicrophones([]);
      setMicrophoneError(`${error instanceof Error ? error.message : 'Microphone access was not available.'} You can continue without candidate audio.`);
    }
  };

  const setMicrophonePreference = (mode: MicrophoneMode, device?: MicrophoneDevice): void => {
    setMicrophoneMode(mode);
    localStorage.setItem('sigmaround.microphone.mode', mode);
    if (mode === 'auto') setMicrophoneLabel('System default');
    if (mode === 'off') setMicrophoneLabel('No candidate microphone');
    if (device) {
      setMicrophoneDeviceId(device.deviceId);
      setMicrophoneLabel(device.label);
      localStorage.setItem('sigmaround.microphone.deviceId', device.deviceId);
      localStorage.setItem('sigmaround.microphone.label', device.label);
    }
    setShowMicrophones(false);
    if (deviceCheckActive) {
      void activateCandidateMicrophone(mode, device?.deviceId ?? '');
    } else if (mode === 'off') {
      setMicrophoneStatus('disabled');
    } else {
      // A failed automatic setup must not leave the pre-start Mic control inert.
      void prepareDeviceCheck().then((ready) => {
        if (ready) void activateCandidateMicrophone(mode, device?.deviceId ?? '');
      });
    }
  };

  const selectMicrophone = (device: MicrophoneDevice): void => {
    setMicrophonePreference('manual', device);
  };

  const toggleAutoAnswer = async (): Promise<void> => {
    const next = !autoAnswerEnabled;
    setShowLiveMenu(false);
    try {
      const enabled = await window.electronAPI.setAutoAnswer(next);
      setAutoAnswerEnabled(enabled);
    } catch (error) {
      store.setError(error instanceof Error ? error.message : 'Could not change Auto Answer.');
    }
  };

  const adjustZoom = async (direction: 'in' | 'out'): Promise<void> => {
    try {
      await window.electronAPI.adjustZoom(direction);
    } catch (error) {
      store.setError(error instanceof Error ? error.message : 'Could not adjust zoom.');
    }
  };

  const adjustOpacity = async (delta: number): Promise<void> => {
    const settings = store.settings;
    if (!settings) return;
    const overlayOpacity = Math.round(Math.max(.35, Math.min(1, settings.overlayOpacity + delta)) * 100) / 100;
    try {
      store.setSettings(await window.electronAPI.saveSettings({ ...settings, overlayOpacity }));
    } catch (error) {
      store.setError(error instanceof Error ? error.message : 'Could not adjust window opacity.');
    }
  };

  useEffect(() => {
    if (!deviceCheckActive) return undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void AudioCapture.audioOutputSignature().then((signature) => {
      if (!disposed) audioOutputSignature.current = signature;
    }).catch(() => undefined);
    const handleOutputChange = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void AudioCapture.audioOutputSignature().then((signature) => {
          if (disposed || signature === audioOutputSignature.current) return;
          audioOutputSignature.current = signature;
          void reconnectSystemAudio();
        }).catch(() => undefined);
      }, 450);
    };
    navigator.mediaDevices.addEventListener('devicechange', handleOutputChange);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      navigator.mediaDevices.removeEventListener('devicechange', handleOutputChange);
    };
  }, [deviceCheckActive]);

  useEffect(() => {
    if (!deviceCheckActive || microphoneMode !== 'auto') return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handleDeviceChange = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void activateCandidateMicrophone('auto'), 350);
    };
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => {
      if (timer) clearTimeout(timer);
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange);
    };
  }, [deviceCheckActive, microphoneMode]);

  const ask = async (questionText = manual): Promise<void> => {
    const visibleQuestion = questionText;
    const question = visibleQuestion.trim();
    if (!running || !activeId || !question || analyzingScreen) return;
    const origin = transcriptDraftEditedRef.current ? 'typed' : 'transcript';
    const submission = ++transcriptSubmission.current;
    const requestEpoch = ++answerRequestEpoch.current;
    answerRequestBaselineId.current = useAppStore.getState().activeAnswerId;
    setAnswerRequestPending(true);
    const transcriptAtSend = useAppStore.getState().activeTranscript.trim();

    // Behave like a chat composer: release the submitted text immediately so
    // the field is ready for the next live transcript or typed question.
    transcriptDraftBaseline.current = transcriptAtSend;
    transcriptDraftReleaseArmed.current = true;
    transcriptDraftEditedRef.current = false;
    setManual('');
    setTranscriptDraftActive(true);
    requestAnimationFrame(() => manualInputRef.current?.focus({ preventScroll: true }));

    const restoreRejectedQuestion = (): void => {
      requestAnimationFrame(() => {
        if (transcriptSubmission.current !== submission) return;
        const currentInput = manualInputRef.current?.value ?? '';
        const currentTranscript = useAppStore.getState().activeTranscript.trim();
        if (currentInput || currentTranscript !== transcriptAtSend) return;
        transcriptDraftReleaseArmed.current = false;
        transcriptDraftEditedRef.current = true;
        setManual(visibleQuestion);
        setTranscriptDraftActive(true);
        requestAnimationFrame(() => {
          const input = manualInputRef.current;
          input?.focus({ preventScroll: true });
          input?.setSelectionRange(input.value.length, input.value.length);
        });
      });
    };

    try {
      store.setError(null);
      // Pressing Enter or Send is always an explicit user chat action, even
      // when its text originally came from the live transcript.
      const accepted = await window.electronAPI.requestAnswer({ sessionId: activeId, question, origin });
      if (!accepted) {
        restoreRejectedQuestion();
        return;
      }
      store.markInterviewerMessageHandled(question);
    } catch (error) {
      restoreRejectedQuestion();
      store.setError(error instanceof Error ? error.message : 'Typed question could not be processed.');
    } finally {
      if (answerRequestEpoch.current === requestEpoch) setAnswerRequestPending(false);
    }
  };

  const sendTopQuestion = async (): Promise<void> => {
    const visibleText = autoAnswerEnabled
      ? displayedQuestion
      : questionEditorRef.current?.value ?? questionDraft;
    const question = visibleText.trim();
    if (!running || !activeId || !question || analyzingScreen || topQuestionSending.current) return;
    topQuestionSending.current = true;
    const origin = !autoAnswerEnabled && questionOwnership.current.edited ? 'typed' : 'transcript';
    const sentOwnership = questionOwnership.current.snapshot(useAppStore.getState().interviewerTurnSequence);
    const requestEpoch = ++answerRequestEpoch.current;
    answerRequestBaselineId.current = useAppStore.getState().activeAnswerId;
    setAnswerRequestPending(true);
    try {
      store.setError(null);
      const accepted = await window.electronAPI.requestAnswer({ sessionId: activeId, question, origin });
      if (accepted) {
        if (!autoAnswerEnabled && questionOwnership.current.finish(sentOwnership, useAppStore.getState().interviewerTurnSequence)) {
          store.finishInterviewerInteraction();
          store.markInterviewerMessageHandled(question);
        }
        if (autoAnswerEnabled) store.markInterviewerMessageHandled(question);
      }
    } catch (error) {
      store.setError(error instanceof Error ? error.message : 'Question could not be processed.');
    } finally {
      topQuestionSending.current = false;
      if (answerRequestEpoch.current === requestEpoch) setAnswerRequestPending(false);
      if (!autoAnswerEnabled) requestAnimationFrame(() => {
        if (questionOwnership.current.isCurrent(sentOwnership, useAppStore.getState().interviewerTurnSequence)) {
          focusQuestionEditorAtEnd();
        }
      });
    }
  };

  // One live-page listener; read only the latest committed state/callback.
  // It is not an OS-global shortcut and never registers during streaming.
  useLayoutEffect(() => {
    manualSendShortcut.current = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.key !== 'Enter' || !event.altKey
        || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      // Consume the chord even when unavailable, so it cannot fall through to
      // ordinary Enter, a focused button, or the Auto Answer bottom composer.
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || autoAnswerEnabled || collapsed || document.hidden
        || showLiveMenu || showAnswerStyle || showSources || showMicrophones || store.screenPreview) return;
      void sendTopQuestion();
    };
  });
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => manualSendShortcut.current(event);
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, []);

  const control = async (mode: AnswerStyleMode): Promise<void> => {
    if (running && activeId && currentQuestion && !analyzingScreen) {
      await window.electronAPI.requestAnswer({ sessionId: activeId, question: currentQuestion, mode });
    }
  };

  const applyAnswerStyle = (label: string, mode: AnswerStyleMode): void => {
    setAnswerStyleLabel(label);
    setShowAnswerStyle(false);
    void control(mode);
  };

  const copyAnswer = (): void => {
    void navigator.clipboard.writeText(displayedAnswer);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };

  const copyQuestion = (): void => {
    const visibleQuestion = autoAnswerEnabled
      ? displayedQuestion
      : questionEditorRef.current?.value ?? questionDraft;
    void navigator.clipboard.writeText(visibleQuestion);
    setQuestionCopied(true);
    setTimeout(() => setQuestionCopied(false), 1_500);
  };

  const selectDesktopSource = async (item: DesktopCaptureSource): Promise<void> => {
    try {
      await runShot(pickerPurpose, item.id, pickerKeepAppVisible.current);
    } catch (error) {
      store.setError(error instanceof Error ? error.message : 'The selected source could not be opened.');
    }
  };

  const runShot = async (kind: ShotKind, sourceId?: string, keepAppVisible = false): Promise<void> => {
    if (shotBusy.current || analyzingScreen) return;
    shotBusy.current = true;
    setCapturingShot(true);
    setShowLiveMenu(false);
    setShowSources(false);
    setScreenError(null);
    try {
      const preview = await window.electronAPI.takeShot({ kind, sourceId, keepAppVisible });
      if (preview) setScreenStreaming(false);
      if (preview && kind !== 'area') {
        setSelectedScreenSourceName(preview.sourceName);
        setSelectedShot({ id: preview.sourceId, kind });
      }
      if (preview) {
        if (running && activeId) {
          void approve(preview);
        } else {
          await window.electronAPI.discardScreenCapture();
          store.setScreenPreview(null);
          setScreenError('Screenshot captured. Press Start before using automatic AI analysis.');
        }
      }
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : 'Capture failed. Choose a source and retry.');
    } finally { shotBusy.current = false; setCapturingShot(false); }
  };

  const quickShot = (): void => {
    if (shotBusy.current || capturingShot || analyzingScreen) return;
    setShowLiveMenu(false);
    if (selectedShot) {
      void runShot(selectedShot.kind, selectedShot.id, true);
      return;
    }
    if (systemSourceId) {
      void runShot('screen', systemSourceId, true);
      return;
    }
    void chooseDesktop('screen', true);
  };

  const quickShotRef = useRef(quickShot);
  useLayoutEffect(() => { quickShotRef.current = quickShot; });
  useEffect(() => window.electronAPI.onEvent('screen:quick-shot', () => {
    quickShotRef.current();
  }), []);

  const setLiveCollapsed = async (next: boolean): Promise<void> => {
    setShowLiveMenu(false);
    const previous = collapsed;
    // Prepare the renderer before changing native bounds. In particular, render
    // the full live UI while the compact launcher is still active, so expanding the native
    // transparent window never exposes a launcher-sized surface over the desktop.
    setCollapsed(next);
    if (!next) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    try {
      await window.electronAPI.setLiveCollapsed(next);
    } catch (error) {
      setCollapsed(previous);
      store.setError(error instanceof Error ? error.message : 'Could not change the live window state.');
    }
  };

  const beginLiveResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    window.electronAPI.resizeLiveWindow('start');
    liveResizeDrag.current = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
    };
  };

  const moveLiveResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = liveResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    window.electronAPI.resizeLiveWindow('move', event.screenX - drag.startX, event.screenY - drag.startY);
  };

  const qaHeightLimits = (): { minimum: number; maximum: number } | null => {
    const widget = liveWidgetRef.current;
    const panel = qaPanelRef.current;
    const transcript = transcriptComposerRef.current;
    if (!widget || !panel || !transcript) return null;
    const widgetRect = widget.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const style = window.getComputedStyle(widget);
    const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    const maximum = Math.max(96, widgetRect.bottom - paddingBottom - transcript.getBoundingClientRect().height - rowGap - panelRect.top);
    return { minimum: Math.min(140, maximum), maximum };
  };

  const beginQaResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || !qaPanelRef.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    qaResizeDrag.current = { pointerId: event.pointerId, startY: event.screenY, startHeight: qaPanelRef.current.getBoundingClientRect().height };
  };

  const moveQaResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = qaResizeDrag.current;
    const limits = qaHeightLimits();
    if (!drag || drag.pointerId !== event.pointerId || !limits) return;
    event.preventDefault();
    setQaPanelHeight(Math.round(Math.max(limits.minimum, Math.min(limits.maximum, drag.startHeight + event.screenY - drag.startY))));
  };

  const endQaResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = qaResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    qaResizeDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const adjustQaFontSize = (change: -1 | 1): void => {
    const nextSize = Math.max(10, Math.min(50, qaFontSize + change));
    if (nextSize === qaFontSize) return;
    const resize = qaFontResizeDelta(qaFontSize, nextSize);
    setQaFontSize(nextSize);
    // A manually sized Q&A row should grow with the native workspace too. In
    // automatic layout mode the flexible grid row absorbs the new height.
    setQaPanelHeight((height) => height === null ? null : Math.max(96, height + resize.height));
    window.electronAPI.resizeLiveWindow('start');
    window.electronAPI.resizeLiveWindow('move', resize.width, resize.height);
    window.electronAPI.resizeLiveWindow('end');
  };

  useLayoutEffect(() => {
    if (qaPanelHeight === null) return undefined;
    const clampHeight = (): void => {
      const limits = qaHeightLimits();
      if (limits) setQaPanelHeight((height) => height === null ? null : Math.round(Math.max(limits.minimum, Math.min(limits.maximum, height))));
    };
    const observer = new ResizeObserver(clampHeight);
    if (liveWidgetRef.current) observer.observe(liveWidgetRef.current);
    return () => observer.disconnect();
  }, [qaPanelHeight]);

  const endLiveResize = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = liveResizeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    window.electronAPI.resizeLiveWindow('end');
    liveResizeDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  async function approve(preview: ScreenCapturePreview): Promise<void> {
    if (!running || !activeId || analyzingScreen) return;
    setAnalyzingScreen(true);
    setScreenStreaming(false);
    setScreenError(null);
    store.setError(null);
    activeScreenCaptureId.current = preview.id;
    const captureId = preview.id;
    firstScreenChunkReported.current = false;
    store.startAnswer();
    store.setCopilotStatus('answering', 'Analyzing screenshot');
    try {
      const visibleQuestion = currentInterviewerInteraction
        || (activeTranscriptRole === 'interviewer' ? activeTranscriptText : '')
        || SCREEN_QUESTION_FALLBACK;
      const result = await window.electronAPI.approveScreenCapture(
        preview.id,
        activeId,
        AUTOMATIC_SCREEN_INSTRUCTION,
        visibleQuestion,
      );
      if (activeScreenCaptureId.current !== captureId) return;
      if (!result.ok) {
        setScreenError(result.error);
        store.setCopilotStatus('recovering', 'Screen analysis failed');
        await window.electronAPI.discardScreenCapture();
        store.setScreenPreview(null);
        return;
      }
      store.setScreenPreview(null);
    } catch (error) {
      if (activeScreenCaptureId.current === captureId) {
        setScreenError(error instanceof Error ? error.message : 'Screen analysis failed. Take another screenshot to retry.');
        store.setCopilotStatus('recovering', 'Screen analysis failed');
        await window.electronAPI.discardScreenCapture().catch(() => undefined);
        store.setScreenPreview(null);
      }
    } finally {
      if (activeScreenCaptureId.current === captureId) {
        setAnalyzingScreen(false);
        const current = useAppStore.getState();
        // Preserve already-visible partial text when a connection or
        // token-limit error occurs after streaming has begun.
        setScreenStreaming(current.answerCaptureId === captureId && Boolean(current.answer.trim()));
        activeScreenCaptureId.current = null;
      }
    }
  }

  const discard = async (): Promise<void> => {
    activeScreenCaptureId.current = null;
    setScreenStreaming(false);
    await window.electronAPI.discardScreenCapture();
    store.setScreenPreview(null);
    setAnalyzingScreen(false);
    setScreenError(null);
  };

  const shotStatus = <>
    {analyzingScreen && <div className="shot-progress" role="status"><span className="shot-pulse"/>{screenStreaming ? 'Streaming answer…' : 'Waiting for first answer text…'}<button onClick={() => void discard()}>Stop</button></div>}
    {screenError && <div className="shot-error" role="alert"><span>{screenError}</span><button aria-label="Dismiss shot error" onClick={() => setScreenError(null)}><X size={13}/></button></div>}
  </>;

  const sourcePicker = showSources ? <div className="source-picker">
    <strong>{pickerPurpose === 'tab' ? 'Tab Shot · choose the browser / app window' : 'Select one window or screen'}</strong>
    {pickerPurpose === 'tab' && <p className="shot-help">Captures the visible tab in this window, including browser chrome. Bring the intended tab to the front first.</p>}
    {!desktopSources.length && <p>No capturable sources were returned. Check recording permissions and keep the intended window visible.</p>}
    <div>{desktopSources.map((item) => <button key={item.id} onClick={() => void selectDesktopSource(item)}><img src={item.thumbnailDataUrl}/><span>{item.name}</span></button>)}</div>
    <button onClick={() => {
      setShowSources(false);
    }}>Cancel</button>
  </div> : null;

  const microphonePicker = showMicrophones ? <div className="source-picker microphone-picker">
    <strong>Microphone</strong>
    <p className="shot-help">Current: {microphoneStatus === 'active' ? microphoneLabel : microphoneStatus === 'disabled' ? 'No microphone' : microphoneLabel}</p>
    <div>
      <button className={microphoneMode === 'auto' ? 'selected' : ''} onClick={() => setMicrophonePreference('auto')}>
         <Mic size={18}/><span>System default</span>{microphoneMode === 'auto' && <Check size={14}/>}
      </button>
      {microphones.filter((device) => !isAutomaticMicrophoneAlias(device)).map((device) => <button className={microphoneMode === 'manual' && device.deviceId === microphoneDeviceId ? 'selected' : ''} key={device.deviceId || device.label} onClick={() => selectMicrophone(device)}>
        <Mic size={18}/><span>{device.label}</span>{microphoneMode === 'manual' && device.deviceId === microphoneDeviceId && <Check size={14}/>}
      </button>)}
      <button className={microphoneMode === 'off' ? 'selected' : ''} onClick={() => setMicrophonePreference('off')}>
        <X size={18}/><span>No microphone</span>{microphoneMode === 'off' && <Check size={14}/>}
      </button>
    </div>
    <button onClick={() => setShowMicrophones(false)}>Cancel</button>
  </div> : null;

  if (!activeId) {
    return <main className="page missing"><h1>No session selected</h1><button className="primary" onClick={() => store.setPage('home')}>View sessions</button></main>;
  }

  if (collapsed) {
    return <FloatingLogo label="Restore Cluera AI live assistant" status={running ? 'active' : 'paused'} onRestore={() => void setLiveCollapsed(false)}/>;
  }

  return <main ref={liveWidgetRef} className="copilot-page live-widget" style={qaPanelHeight === null ? undefined : { gridTemplateRows: `${qaPanelHeight}px auto minmax(0, 1fr)` }}>
    <aside className="live-side-rail" aria-label="Live controls">
      <div className="live-rail-scroll">
        <span className="live-drag-handle" title="Drag Cluera AI"><Move size={15}/></span>
        <span className="live-session-timer" aria-label={`Session time ${sessionTimer}`} title="Live session time">{sessionTimer}</span>
        <button
          className={running ? 'stop-listening' : `start-listening${deviceCheckReady ? ' ready-to-start' : ''}`}
          aria-label={running ? 'Stop interview' : 'Start interview'}
          title={running ? 'Stop interview' : 'Start interview'}
          disabled={systemAudioStatus === 'starting'}
          onClick={() => running ? void stop() : void start()}
        >{running ? <Square size={14}/> : <Play size={15}/>}</button>
        <button disabled={store.activeQaIndex <= 0} aria-label="Previous answer" title="Previous answer · Alt+A" onClick={() => store.selectQa(store.activeQaIndex - 1)}><ChevronLeft size={16}/></button>
        <button disabled={store.activeQaIndex < 0 || store.activeQaIndex >= store.liveQaItems.length - 1} aria-label="Next answer" title="Next answer · Alt+D" onClick={() => store.selectQa(store.activeQaIndex + 1)}><ChevronRight size={16}/></button>
        <button className={`rail-status ${systemAudioStatus}`} aria-label="Reconnect audio output" title={`Audio output: ${systemSourceName} (${systemAudioStatus}). Click to follow the current Windows output.`} onClick={() => void reconnectSystemAudio()}><AudioLines size={15}/><i/></button>
        <button className={`rail-status ${microphoneStatus}`} aria-label="Change microphone" title={`Microphone: ${microphoneLabel} (${microphoneStatus}). Click to change.`} onClick={() => void chooseMicrophone()}><Mic size={15}/><i/></button>
        <button disabled={capturingShot || analyzingScreen} aria-label="Take screenshot" aria-keyshortcuts="Alt+C" title="Capture and automatically answer the current screen (Alt+C)" onClick={quickShot}><Camera size={15}/></button>
        <button ref={moreButtonRef} className={showLiveMenu ? 'active' : ''} aria-label="More controls" title="More controls" onClick={() => { setShowAnswerStyle(false); setShowLiveMenu((open) => !open); }}><MoreHorizontal size={16}/></button>
        <span className="rail-spacer"/>
        <button aria-label="Collapse to floating logo" title="Collapse to floating logo" onClick={() => void setLiveCollapsed(true)}><Minimize2 size={15}/></button>
      </div>
      {showLiveMenu && <div ref={liveMenuRef} className="live-menu" role="menu">
        <div className="live-menu-control" role="group" aria-label="Zoom controls">
          <span><SlidersHorizontal size={13}/>Zoom</span>
          <div>
            <button aria-label="Zoom out" title="Zoom out" onClick={() => void adjustZoom('out')}><ZoomOut size={13}/></button>
            <button aria-label="Zoom in" title="Zoom in" onClick={() => void adjustZoom('in')}><ZoomIn size={13}/></button>
          </div>
        </div>
        <div className="live-menu-control" role="group" aria-label="Question and answer font size">
          <span><MessageCircle size={13}/>Q&amp;A text {qaFontSize}px</span>
          <div>
            <button aria-label="Decrease question and answer font size" title="Decrease Q&A font size" disabled={qaFontSize <= 10} onClick={() => adjustQaFontSize(-1)}>A-</button>
            <button aria-label="Increase question and answer font size" title="Increase Q&A font size" disabled={qaFontSize >= 50} onClick={() => adjustQaFontSize(1)}>A+</button>
          </div>
        </div>
        <button role="menuitem" disabled={analyzingScreen} onClick={() => { setShowLiveMenu(false); void runShot('area'); }}><Crop size={13}/>Area Shot</button>
        <ThemeControl/>
        <PrivateModeControl/>
        <div className="live-menu-control" role="group" aria-label="Opacity controls">
          <span><SunMedium size={13}/>Opacity {Math.round((store.settings?.overlayOpacity ?? .96) * 100)}%</span>
          <div>
            <button aria-label="Decrease opacity" title="Decrease opacity" onClick={() => void adjustOpacity(-.05)}>-</button>
            <button aria-label="Increase opacity" title="Increase opacity" onClick={() => void adjustOpacity(.05)}>+</button>
          </div>
        </div>
        <button className="menu-toggle-control" role="menuitemcheckbox" aria-checked={autoAnswerEnabled} onClick={() => void toggleAutoAnswer()}>
          <WandSparkles size={13}/>
          <span className="menu-toggle-label">Auto Answer <span className="beta-badge">Beta</span></span>
          <span className={`menu-toggle-track${autoAnswerEnabled ? ' on' : ''}`} aria-hidden="true"><i/></span>
          <span className="menu-toggle-state">{autoAnswerEnabled ? 'ON' : 'OFF'}</span>
        </button>
        <button className="menu-toggle-control" role="menuitemcheckbox" aria-label="Auto Scroll" aria-checked={autoScrollEnabled} onClick={toggleAutoScroll}>
          <span className="menu-toggle-label">Auto Scroll</span>
          <span className={`menu-toggle-track${autoScrollEnabled ? ' on' : ''}`} aria-hidden="true"><i/></span>
          <span className="menu-toggle-state">{autoScrollEnabled ? 'ON' : 'OFF'}</span>
        </button>
        <button role="menuitem" onClick={() => { setShowLiveMenu(false); store.setPage('create'); }}><Edit3 size={13}/>Edit Session</button>
        <button role="menuitem" onClick={openProviderSettings}><Settings2 size={13}/>AI provider settings</button>
        <button className="end-session" role="menuitem" onClick={() => void endSession()}><LogOut size={13}/>End Session</button>
      </div>}
      <button
        className="live-resize-handle"
        aria-label="Resize Cluera AI window"
        title="Drag diagonally to resize"
        onPointerDown={beginLiveResize}
        onPointerMove={moveLiveResize}
        onPointerUp={endLiveResize}
        onPointerCancel={endLiveResize}
      />
    </aside>

      <section className="live-qa-panel" ref={qaPanelRef} style={{ '--qa-font-size': `${qaFontSize}px` } as CSSProperties}>
        {(running || store.liveQaItems.length > 0 || store.screenContext) && <div className="qa-panel-tools">
          <span>{store.liveQaItems.length ? `${store.activeQaIndex + 1}/${store.liveQaItems.length}` : ''}</span>
          <div>
            {store.screenContext && <span className="screen-context-ready"><Sparkles size={10}/>Screen context</span>}
            {running && <span className={`live-status-dot ${store.copilotStatus}`}>{statusLabels[store.copilotStatus]}</span>}
          </div>
        </div>}
        {shotStatus}
        <div className="qa-scroll" ref={answerPanelRef} tabIndex={0} role="region" aria-label="Answer reading area"
          onKeyDown={scrollAnswer} onWheel={holdManualScroll} onTouchStart={holdManualScroll}
          onPointerDown={(event) => {
            holdManualScroll();
            if (event.target instanceof HTMLElement && !event.target.closest('input, textarea, select, [contenteditable], button, a')) {
              event.currentTarget.focus({ preventScroll: true });
            }
          }} onScroll={preserveManualScrollExtent}>
          <div className="qa-content" ref={qaContentRef}>
          <div className="qa-row question-row">
            <MessageCircle size={13}/>
            <div className={`qa-copy${autoAnswerEnabled ? '' : ' question-editing'}`}><strong>Question:</strong>{' '}
              {autoAnswerEnabled
                ? <span>{displayedQuestion}</span>
                : <textarea
                    ref={questionEditorRef}
                    className="question-text-editor"
                    rows={1}
                    autoFocus
                    aria-label="Edit current question"
                    placeholder="Interviewer's question will appear here..."
                    spellCheck
                    value={questionDraft}
                    onChange={(event) => {
                      questionOwnership.current.edit(useAppStore.getState().interviewerTurnSequence);
                      questionFocusEpoch.current += 1;
                      setQuestionDraft(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      void sendTopQuestion();
                    }}
                  />}
            </div>
            <div className="question-actions">
              <button aria-label="Send shown question" aria-keyshortcuts={autoAnswerEnabled ? undefined : 'Alt+Enter'} title={autoAnswerEnabled ? 'Send shown question' : 'Send shown question · Alt+Enter'} disabled={!running || !(autoAnswerEnabled ? hasDisplayedQuestion : questionDraft.trim()) || analyzingScreen} onMouseDown={(event) => { if (!autoAnswerEnabled) event.preventDefault(); }} onClick={() => void sendTopQuestion()}><Send size={13}/></button>
              <button aria-label="Copy question" title="Copy question" onClick={copyQuestion}>{questionCopied ? <Check size={13}/> : <Clipboard size={13}/>}</button>
            </div>
          </div>
          <div className="qa-row answer-row">
            <Star size={14}/>
            <div className="qa-copy answer-copy">
              <strong>Answer:</strong>
              {answerRequestPending
                ? <span className="answer-waiting">Generating answer…</span>
                : displayedAnswer
                ? <div className="answer-reading-progress">
                    <FormattedAnswer text={displayedAnswer} streaming={Boolean(activeQa?.streaming)}/>
                  </div>
                : generatingAnswer
                  ? <span className="answer-waiting">Generating answer...</span>
                  : running
                    ? <span className="answer-waiting">Waiting for an interviewer question...</span>
                    : <span className={`answer-waiting pre-start-device-message${deviceDetectionInProgress ? ' detecting' : ' ready'}`}>
                        {preStartAnswerMessage}
                        {deviceDetectionInProgress && <span className="device-check-dots" aria-hidden="true"><i/><i/><i/></span>}
                      </span>}
            </div>
          </div>
          </div>
        </div>
        <footer className="qa-footer">
          <span>{running ? statusLabels[store.copilotStatus] : ''}{latency ? `${running ? ' · ' : ''}${latency}` : ''}</span>
          <div className="qa-footer-actions">
            <div className="answer-style-control">
              <button
                ref={answerStyleButtonRef}
                className={showAnswerStyle ? 'active' : ''}
                aria-haspopup="menu"
                aria-expanded={showAnswerStyle}
                disabled={!running || !displayedAnswer}
                onClick={() => { setShowLiveMenu(false); setShowAnswerStyle((open) => !open); }}
              ><SlidersHorizontal size={12}/>Style: {answerStyleLabel}<ChevronDown size={11}/></button>
              {showAnswerStyle && <div ref={answerStyleMenuRef} className="answer-style-menu" role="menu">
                {ANSWER_STYLES.map((style) => <button
                  key={style.mode}
                  role="menuitemradio"
                  aria-checked={answerStyleLabel === style.label}
                  onClick={() => applyAnswerStyle(style.label, style.mode)}
                >{answerStyleLabel === style.label && <Check size={11}/>}<span>{style.label}</span></button>)}
              </div>}
            </div>
            <button disabled={!displayedAnswer} onClick={copyAnswer}>{copied ? <Check size={12}/> : <Clipboard size={12}/>}Copy</button>
          </div>
        </footer>
        <button
          className="live-qa-resize-handle"
          aria-label="Adjust question and answer height"
          title="Drag to adjust the question and answer height"
          onPointerDown={beginQaResize}
          onPointerMove={moveQaResize}
          onPointerUp={endQaResize}
          onPointerCancel={endQaResize}
        />
      </section>

      <form className="live-transcript-composer" ref={transcriptComposerRef} onSubmit={(event) => {
      event.preventDefault();
      if (autoAnswerEnabled && running) void ask(manualInputRef.current?.value ?? transcriptInputValue);
    }}>
      <span className={`speaker-chip ${activeTranscriptRole ?? 'waiting'}`}>{activeTranscriptText ? activeSpeaker : 'Live'}</span>
      <div className="transcript-input-shell">
        <input
          ref={manualInputRef}
          type="text"
          value={transcriptInputValue}
          onFocus={() => {
            // Focusing for selection/copy is not an edit. Continue following live
            // speech until an actual input change creates a manual draft.
            if (!autoFocusingTranscript.current && transcriptDraftActive) transcriptDraftReleaseArmed.current = false;
          }}
          onBlur={() => {
            if (!transcriptDraftActive) return;
            // Speech received while the user was editing is part of the baseline,
            // not permission to overwrite the draft. Only a later transcript can
            // return this field to live-following mode.
            transcriptDraftBaseline.current = activeTranscriptText;
            transcriptDraftReleaseArmed.current = true;
          }}
          onChange={(event) => {
            if (!transcriptDraftActive) transcriptDraftBaseline.current = activeTranscriptText;
            transcriptDraftReleaseArmed.current = false;
            transcriptDraftEditedRef.current = true;
            setTranscriptDraftActive(true);
            setManual(event.target.value);
          }}
          placeholder={deviceCheckActive ? running ? 'Listening… or type a missed question' : 'Device check listening… Start enables AI' : 'Preparing microphone and audio output…'}
        />
        <button type="button" className="transcript-clear" aria-label="Clear transcript input" title="Clear" disabled={!transcriptInputValue} onMouseDown={(event) => event.preventDefault()} onClick={() => {
          transcriptDraftBaseline.current = activeTranscriptText;
          transcriptDraftReleaseArmed.current = false;
          transcriptDraftEditedRef.current = true;
          setTranscriptDraftActive(true);
          setManual('');
          manualInputRef.current?.focus();
        }}>Clear</button>
        {autoAnswerEnabled && <button type="submit" className="transcript-answer" aria-label="Send current question" title="Send current question" disabled={!running || !transcriptAnswerText || analyzingScreen} onMouseDown={(event) => event.preventDefault()}>
          Send
        </button>}
      </div>
    </form>

    {sourcePicker}
    {microphonePicker}
    {store.providerStatus?.demoMode && <div className="live-notice"><WandSparkles size={12}/>Demo answers are active</div>}
    {store.error && <div className="live-error"><X size={14}/><span>{store.error}</span></div>}
    {microphoneError && <div className="live-error microphone-error"><Mic size={14}/><span>{microphoneError}</span><button aria-label="Choose microphone" onClick={() => void chooseMicrophone()}>Choose mic</button></div>}
  </main>;
}
