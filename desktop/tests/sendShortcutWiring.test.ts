import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('Alt+S send shortcut wiring', () => {
  const ipc = read('src/main/ipc/registerIpc.ts');
  const preload = read('src/preload/preload.ts');
  const shared = read('src/shared/ipc.ts');
  const page = read('src/renderer/pages/CopilotPage.tsx');

  it('is registered system-wide only on request from the live page, and released with the session', () => {
    expect(ipc).toContain("globalShortcut.register('Alt+S'");
    expect(ipc).toContain("globalShortcut.unregister('Alt+S')");
    // The key is taken only while the page asks for it, never just because a session window is open.
    expect(ipc).toContain("ipcMain.handle(IPC.app.sendShortcut");
    expect(ipc).toContain('if (!enabled || !sessionModeActive) { releaseSendShortcut(); return false; }');
    expect(ipc).toContain('else { releaseQuickShotShortcut(); releaseSendShortcut(); }');
    expect(ipc).toContain('releaseSendShortcut();\n    app.removeListener');
    expect(ipc).toContain("window.webContents.send(IPC.events, 'answer:send-shortcut', null)");
    expect(ipc).toContain("if (event.sender !== window.webContents) throw new Error('Unauthorized shortcut request.')");
  });

  it('is exposed to the page through the preload bridge with matching channel names', () => {
    expect(shared).toContain("sendShortcut: 'app:send-shortcut'");
    expect(preload).toContain("sendShortcut: 'app:send-shortcut'");
    expect(preload).toContain('setSendShortcut: (enabled) => ipcRenderer.invoke(IPC.app.sendShortcut, enabled === true)');
    expect(shared).toContain("discardInput: 'interview:discard-input'");
    expect(preload).toContain("discardInput: 'interview:discard-input'");
    expect(preload).toContain('discardTranscriptInput: () => ipcRenderer.invoke(IPC.interview.discardInput)');
  });

  it('acts only when Auto Answer is off and the session is running, and is asked for only then', () => {
    expect(page).toContain('if (autoAnswerEnabled || collapsed) return false;');
    expect(page).toContain("window.electronAPI.setSendShortcut?.(running && !autoAnswerEnabled && !collapsed)");
    expect(page).toContain("window.electronAPI.onEvent('answer:send-shortcut'");
    expect(page).toContain("event.code !== 'KeyS' || !event.altKey");
    // Alt+Enter and the Send button keep working as before.
    expect(page).toContain("event.key !== 'Enter' || !event.altKey");
    expect(page).toContain('onClick={() => void sendTopQuestion()}');
  });

  it('does not make the cleared text come back', () => {
    expect(page).toContain('window.electronAPI.discardTranscriptInput?.()');
    expect(page).toContain('useAppStore.getState().discardLiveInput()');
    expect(read('src/main/interview/InterviewOrchestrator.ts')).toContain('discardInput(): void');
  });

  it('keeps the scroll area from growing every time it is scrolled to the end', () => {
    expect(page).toContain('panel.scrollTop + panel.clientHeight - scrollChromeHeight(panel)');
    expect(page).toContain('qaContentRef.current.style.minHeight = `${qaContentRef.current.offsetHeight}px`');
    expect(page).toContain('readingController.current?.focusQuestion()');
  });
});
