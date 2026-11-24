import type {
  AnswerRequest,
  AppEventMap,
  AppEventName,
  AppSettings,
  AudioSourceDescriptor,
  DesktopCaptureSource,
  DocumentRecord,
  ExtractedDocument,
  LibraryFile,
  LibraryFileCategory,
  LibraryFileContent,
  ProviderName,
  ProviderStatus,
  Session,
  SessionDetail,
  SessionInput,
  SessionSummary,
  RoundHistory,
  ScreenCapturePreview,
  ScreenAnalysisApprovalResult,
  ScreenContext,
  SelectedScreenSource,
  UploadedDocumentInput,
  ShotRequest,
  UpdateStatus,
} from './types';

export const IPC = {
  app: { status: 'app:status', close: 'app:close', openExternal: 'app:open-external', toggleOverlay: 'app:toggle-overlay', adjustZoom: 'app:adjust-zoom', sessionMode: 'app:session-mode', liveCollapse: 'app:live-collapse', moveLiveCollapse: 'app:move-live-collapse', resizeLive: 'app:resize-live', focusLiveTranscript: 'app:focus-live-transcript', sendShortcut: 'app:send-shortcut', assignmentMode: 'app:assignment-mode' },
  sessions: {
    startRound: 'sessions:start-round',
    roundHistory: 'sessions:round-history',
    list: 'sessions:list', get: 'sessions:get', save: 'sessions:save', delete: 'sessions:delete', summary: 'sessions:summary',
  },
  documents: { select: 'documents:select', read: 'documents:read', addExtracted: 'documents:add-extracted', addText: 'documents:add-text', remove: 'documents:remove' },
  library: { list: 'library:list', upload: 'library:upload', get: 'library:get', delete: 'library:delete' },
  interview: {
    start: 'interview:start', stop: 'interview:stop', pause: 'interview:pause', interaction: 'interview:interaction', autoAnswer: 'interview:auto-answer', answer: 'interview:answer', clear: 'interview:clear', discardInput: 'interview:discard-input',
  },
  audio: { chunk: 'audio:chunk', error: 'audio:error', selectSystemSource: 'audio:select-system-source' },
  screen: { sources: 'screen:sources', captureDesktop: 'screen:capture-desktop', captureCurrent: 'screen:capture-current', selectedSource: 'screen:selected-source', approve: 'screen:approve', discard: 'screen:discard', firstVisible: 'screen:first-visible', shot: 'screen:shot', clearContext: 'screen:clear-context' },
  settings: { get: 'settings:get', save: 'settings:save' },
  providers: { status: 'providers:status' },
  updates: { status: 'updates:status', check: 'updates:check', openDownload: 'updates:open-download', install: 'updates:install', cancel: 'updates:cancel' },
  events: 'events:message',
} as const;

export interface ElectronAPI {
  readonly bridgeVersion: string;
  /** `fresh` asks the app to reload the approved model list before answering instead of using its short-lived copy. */
  getProviderStatus(fresh?: boolean): Promise<ProviderStatus>;
  closeWindow(): Promise<void>;
  openExternal(kind: 'tutorial' | 'support' | 'supportGmail' | 'supportMail'): Promise<void>;
  toggleOverlay(): Promise<void>;
  adjustZoom(direction: 'in' | 'out'): Promise<number>;
  setSessionWindowMode(active: boolean): Promise<void>;
  setLiveCollapsed(collapsed: boolean): Promise<void>;
  moveLiveCollapsed(phase: 'start' | 'move' | 'end', screenX?: number, screenY?: number): void;
  resizeLiveWindow(phase: 'start' | 'move' | 'end', deltaX?: number, deltaY?: number, diagonal?: boolean): void;
  focusLiveTranscript(forceQuestionFocus?: boolean): Promise<boolean>;
  listSessions(): Promise<Session[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  startSessionRound(id: string, note: string): Promise<void>;
  getRoundHistory(sessionId: string, roundId: string, page: number): Promise<RoundHistory>;
  saveSession(input: SessionInput): Promise<Session>;
  deleteSession(id: string): Promise<void>;
  getSessionSummary(id: string): Promise<SessionSummary>;
  selectDocument(input: UploadedDocumentInput): Promise<DocumentRecord | null>;
  selectContextFile(): Promise<ExtractedDocument | null>;
  addExtractedDocument(input: UploadedDocumentInput & { document: ExtractedDocument }): Promise<DocumentRecord>;
  addTextDocument(input: UploadedDocumentInput & { name: string; text: string }): Promise<DocumentRecord>;
  removeDocument(id: string): Promise<void>;
  listLibraryFiles(): Promise<LibraryFile[]>;
  uploadLibraryFile(category: LibraryFileCategory): Promise<LibraryFileContent | null>;
  getLibraryFile(id: string): Promise<LibraryFileContent>;
  deleteLibraryFile(id: string): Promise<void>;
  startInterview(sessionId: string, source: AudioSourceDescriptor, interactionEnabled?: boolean): Promise<void>;
  stopInterview(): Promise<void>;
  pauseInterview(paused: boolean): Promise<void>;
  setInterviewInteractionEnabled(enabled: boolean): Promise<boolean>;
  setAutoAnswer(enabled: boolean): Promise<boolean>;
  requestAnswer(input: AnswerRequest): Promise<boolean>;
  clearCurrentAnswer(): Promise<void>;
  /** Clear pressed: forget what has been captured so far in the current spoken turn so it never comes back. */
  discardTranscriptInput(): Promise<void>;
  /** Registers the Alt+S shortcut that sends the shown question, even while another app has focus. Returns whether it is active. */
  setSendShortcut(enabled: boolean): Promise<boolean>;
  /**
   * Assignment sessions only. While active, the window ignores the mouse so clicks reach the page behind it, and
   * Alt+M (touch on/off), Alt+Up/Down (scroll the answer) and Alt+A/Alt+D (previous/next answer) work system-wide.
   * Returns whether it is active and whether clicks currently pass through.
   */
  setAssignmentMode(enabled: boolean): Promise<{ active: boolean; touchThrough: boolean }>;
  sendAudioChunk(sourceId: string, chunk: ArrayBuffer): void;
  reportAudioError(message: string): void;
  selectSystemAudioSource(sourceId: string): Promise<string>;
  listDesktopCaptureSources(): Promise<DesktopCaptureSource[]>;
  captureDesktopSource(sourceId: string): Promise<ScreenCapturePreview | null>;
  captureCurrentScreen(): Promise<ScreenCapturePreview | null>;
  takeShot(request: ShotRequest): Promise<ScreenCapturePreview | null>;
  clearScreenContext(): Promise<void>;
  getSelectedScreenSource(): Promise<SelectedScreenSource | null>;
  approveScreenCapture(captureId: string, sessionId: string, instruction: string, visibleQuestion?: string): Promise<ScreenAnalysisApprovalResult>;
  reportScreenAnswerVisible(captureId: string): Promise<void>;
  discardScreenCapture(): Promise<void>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  getUpdateStatus(): Promise<UpdateStatus>;
  checkForUpdates(): Promise<UpdateStatus>;
  openUpdateDownload(): Promise<void>;
  installUpdate(): Promise<UpdateStatus>;
  cancelUpdate(): Promise<void>;
  onEvent<K extends AppEventName>(name: K, callback: (payload: AppEventMap[K]) => void): () => void;
}
