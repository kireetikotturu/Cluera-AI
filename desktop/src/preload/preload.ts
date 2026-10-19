import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI } from '../shared/ipc';
import type { AccountDesktopAPI, AccountView } from '../shared/accounts';
import type { AppEventMap, AppEventName } from '../shared/types';

// A sandboxed Electron preload may only require a small set of built-in modules.
// Keep channel values in this self-contained file so the compiled preload does
// not call require('../shared/ipc') and silently fail before exposing the bridge.
const IPC = {
  app: { status: 'app:status', close: 'app:close', openExternal: 'app:open-external', toggleOverlay: 'app:toggle-overlay', adjustZoom: 'app:adjust-zoom', sessionMode: 'app:session-mode', liveCollapse: 'app:live-collapse', moveLiveCollapse: 'app:move-live-collapse', resizeLive: 'app:resize-live', focusLiveTranscript: 'app:focus-live-transcript' },
  sessions: { roundHistory: 'sessions:round-history', startRound: 'sessions:start-round', list: 'sessions:list', get: 'sessions:get', save: 'sessions:save', delete: 'sessions:delete', summary: 'sessions:summary' },
  documents: { select: 'documents:select', read: 'documents:read', addExtracted: 'documents:add-extracted', addText: 'documents:add-text', remove: 'documents:remove' },
  library: { list: 'library:list', upload: 'library:upload', get: 'library:get', delete: 'library:delete' },
  interview: { start: 'interview:start', stop: 'interview:stop', pause: 'interview:pause', interaction: 'interview:interaction', autoAnswer: 'interview:auto-answer', answer: 'interview:answer', clear: 'interview:clear' },
  audio: { chunk: 'audio:chunk', error: 'audio:error', selectSystemSource: 'audio:select-system-source' },
  screen: { sources: 'screen:sources', captureDesktop: 'screen:capture-desktop', captureCurrent: 'screen:capture-current', selectedSource: 'screen:selected-source', approve: 'screen:approve', discard: 'screen:discard', firstVisible: 'screen:first-visible', shot: 'screen:shot', clearContext: 'screen:clear-context' },
  settings: { get: 'settings:get', save: 'settings:save' },
  updates: { status: 'updates:status', check: 'updates:check', openDownload: 'updates:open-download', install: 'updates:install', cancel: 'updates:cancel' },
  events: 'events:message',
} as const;

const api: ElectronAPI = {
  bridgeVersion: '2.0.0',
  getProviderStatus: () => ipcRenderer.invoke(IPC.app.status),
  closeWindow: () => ipcRenderer.invoke(IPC.app.close), openExternal: (kind) => ipcRenderer.invoke(IPC.app.openExternal, kind), toggleOverlay: () => ipcRenderer.invoke(IPC.app.toggleOverlay),
  adjustZoom: (direction) => ipcRenderer.invoke(IPC.app.adjustZoom, direction),
  setSessionWindowMode: (active) => ipcRenderer.invoke(IPC.app.sessionMode, active),
  setLiveCollapsed: (collapsed) => ipcRenderer.invoke(IPC.app.liveCollapse, collapsed),
  moveLiveCollapsed: (phase, screenX, screenY) => ipcRenderer.send(IPC.app.moveLiveCollapse, phase, screenX, screenY),
  resizeLiveWindow: (phase, deltaX, deltaY, diagonal) => ipcRenderer.send(IPC.app.resizeLive, phase, deltaX, deltaY, diagonal),
  focusLiveTranscript: (forceQuestionFocus) => ipcRenderer.invoke(IPC.app.focusLiveTranscript, forceQuestionFocus === true),
  listSessions: () => ipcRenderer.invoke(IPC.sessions.list), getSession: (id) => ipcRenderer.invoke(IPC.sessions.get, id),
  saveSession: (input) => ipcRenderer.invoke(IPC.sessions.save, input), deleteSession: (id) => ipcRenderer.invoke(IPC.sessions.delete, id),
  getSessionSummary: (id) => ipcRenderer.invoke(IPC.sessions.summary, id),
  startSessionRound: (id, note) => ipcRenderer.invoke(IPC.sessions.startRound, id, note),
  getRoundHistory: (id, round, page) => ipcRenderer.invoke(IPC.sessions.roundHistory, id, round, page),
  selectDocument: (input) => ipcRenderer.invoke(IPC.documents.select, input),
  selectContextFile: () => ipcRenderer.invoke(IPC.documents.read),
  addExtractedDocument: (input) => ipcRenderer.invoke(IPC.documents.addExtracted, input),
  addTextDocument: (input) => ipcRenderer.invoke(IPC.documents.addText, input), removeDocument: (id) => ipcRenderer.invoke(IPC.documents.remove, id),
  listLibraryFiles: () => ipcRenderer.invoke(IPC.library.list),
  uploadLibraryFile: (category) => ipcRenderer.invoke(IPC.library.upload, category),
  getLibraryFile: (id) => ipcRenderer.invoke(IPC.library.get, id),
  deleteLibraryFile: (id) => ipcRenderer.invoke(IPC.library.delete, id),
  startInterview: (id, source, interactionEnabled) => ipcRenderer.invoke(IPC.interview.start, id, source, interactionEnabled), stopInterview: () => ipcRenderer.invoke(IPC.interview.stop),
  pauseInterview: (paused) => ipcRenderer.invoke(IPC.interview.pause, paused), setInterviewInteractionEnabled: (enabled) => ipcRenderer.invoke(IPC.interview.interaction, enabled), setAutoAnswer: (enabled) => ipcRenderer.invoke(IPC.interview.autoAnswer, enabled), requestAnswer: (input) => ipcRenderer.invoke(IPC.interview.answer, input),
  clearCurrentAnswer: () => ipcRenderer.invoke(IPC.interview.clear),
  sendAudioChunk: (source, chunk) => ipcRenderer.send(IPC.audio.chunk, source, chunk), reportAudioError: (message) => ipcRenderer.send(IPC.audio.error, message),
  selectSystemAudioSource: (sourceId) => ipcRenderer.invoke(IPC.audio.selectSystemSource, sourceId),
  listDesktopCaptureSources: () => ipcRenderer.invoke(IPC.screen.sources), captureDesktopSource: (sourceId) => ipcRenderer.invoke(IPC.screen.captureDesktop, sourceId),
  captureCurrentScreen: () => ipcRenderer.invoke(IPC.screen.captureCurrent),
  takeShot: (request) => ipcRenderer.invoke(IPC.screen.shot, request),
  clearScreenContext: () => ipcRenderer.invoke(IPC.screen.clearContext),
  getSelectedScreenSource: () => ipcRenderer.invoke(IPC.screen.selectedSource),
  approveScreenCapture: (captureId, sessionId, instruction, visibleQuestion) => ipcRenderer.invoke(IPC.screen.approve, captureId, sessionId, instruction, visibleQuestion),
  reportScreenAnswerVisible: (captureId) => ipcRenderer.invoke(IPC.screen.firstVisible, captureId),
  discardScreenCapture: () => ipcRenderer.invoke(IPC.screen.discard),
  getSettings: () => ipcRenderer.invoke(IPC.settings.get), saveSettings: (settings) => ipcRenderer.invoke(IPC.settings.save, settings),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.updates.status),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updates.check),
  openUpdateDownload: () => ipcRenderer.invoke(IPC.updates.openDownload),
  installUpdate: () => ipcRenderer.invoke(IPC.updates.install),
  cancelUpdate: () => ipcRenderer.invoke(IPC.updates.cancel),
  onEvent: <K extends AppEventName>(name: K, callback: (payload: AppEventMap[K]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, incoming: AppEventName, payload: AppEventMap[AppEventName]): void => {
      if (incoming === name) callback(payload as AppEventMap[K]);
    };
    ipcRenderer.on(IPC.events, listener);
    return () => ipcRenderer.removeListener(IPC.events, listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
const accountApi: AccountDesktopAPI = {
  credits:{refresh:()=>ipcRenderer.invoke('account:credits'),onChange(callback){
    const listener=(_event:Electron.IpcRendererEvent,view:import('../shared/accountCredits').CreditsView)=>callback(view);
    ipcRenderer.on('account:credits-state',listener);return()=>ipcRenderer.removeListener('account:credits-state',listener);
  }},
  status: () => ipcRenderer.invoke('account:status'),
  authOptions: () => ipcRenderer.invoke('account:auth-options'),
  context: {
    list:()=>ipcRenderer.invoke('account:context-list'),
    select:ids=>ipcRenderer.invoke('account:context-select',ids),
    read:id=>ipcRenderer.invoke('account:context-read',id),
    change:input=>ipcRenderer.invoke('account:context-change',input),
    retry:()=>ipcRenderer.invoke('account:context-retry'),
    importFile:kind=>ipcRenderer.invoke('account:context-import',kind),
  },
  login: input => ipcRenderer.invoke('account:login', input),
  google: () => ipcRenderer.invoke('account:google'),
  retry: () => ipcRenderer.invoke('account:retry'),
  logout: allDevices => ipcRenderer.invoke('account:logout', allDevices),
  openWeb: action => ipcRenderer.invoke('account:open-web', action),
  onStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: AccountView) => callback(state);
    ipcRenderer.on('account:state', listener);
    return () => ipcRenderer.removeListener('account:state', listener);
  },
};
contextBridge.exposeInMainWorld('accountAPI', accountApi);
ipcRenderer.send('app:preload-ready', { version: api.bridgeVersion });
