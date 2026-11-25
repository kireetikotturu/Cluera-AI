import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('finding the microphone and the Windows output when a session opens', () => {
  const page = read('src/renderer/pages/CopilotPage.tsx');

  it('keeps the device check state where every earlier callback can see the latest value', () => {
    expect(page).toContain('const markDeviceCheckActive = (active: boolean): void => { deviceCheckActiveRef.current = active; setDeviceCheckActive(active); };');
    // The state setter is called only through that helper.
    expect(page.match(/setDeviceCheckActive\(/g)).toHaveLength(1);
    // A callback created earlier never starts a second check over a working one.
    expect(page).toContain('if (deviceCheckActiveRef.current && preparedSessionId.current === activeId) return Promise.resolve(true);');
    expect(page).toContain('if (!deviceCheckActiveRef.current) {\n        const ready = await prepareDeviceCheck();');
  });

  it('never replaces the real reason with a vague message', () => {
    expect(page).not.toContain('Audio device checking could not be prepared.');
    expect(page).toContain("if (!useAppStore.getState().error) store.setError('The live connection is still getting ready. Try the audio button again in a moment.');");
    expect(page).toContain("if (!useAppStore.getState().error) store.setError('The live connection is still getting ready. Press Start again in a moment.');");
  });

  it('tries the Windows output again a moment later before reporting a problem', () => {
    expect(page).toContain('const startSystemAudio = async (sessionId: string | null, attempts = 3): Promise<void> => {');
    expect(page).toContain('await startSystemAudio(sessionId);');
    expect(page).toContain('await startSystemAudio(null, 2);');
    expect(page).toContain('setTimeout(resolve, attempt === 1 ? 600 : 1_500)');
    // A retry that stops because the session ended or changed meanwhile.
    expect(page).toContain('if (sessionId !== null && preparedSessionId.current !== sessionId) throw lastError;');
    // The banner of a failed first try goes away once a retry works.
    expect(page).toContain("useAppStore.getState().error?.startsWith('Audio capture:')");
  });

  it('asks for the automatic microphone again, but not when it was refused', () => {
    expect(page).toContain("const attempts = mode === 'auto' ? 3 : 1;");
    expect(page).toContain('setTimeout(resolve, attempt === 1 ? 700 : 1_800)');
    expect(page).toContain("error.name === 'NotAllowedError' || error.name === 'SecurityError'");
    expect(page).toContain('if (attempt + 1 < attempts && !refused) continue;');
  });

  it('prepares again by itself when preparing failed, a limited number of times, and stops with the page', () => {
    expect(page).toContain('const delay = [1_200, 3_000, 6_000][deviceCheckAttempts.current];');
    expect(page).toContain('if (deviceCheckRetryTimer.current !== null || deviceCheckAttempts.current >= 3) return;');
    expect(page).toContain('scheduleDeviceCheckRetry(sessionId);');
    expect(page).toContain('prepareDeviceCheckRef.current = prepareDeviceCheck;');
    // Cleared when the page closes, the session ends or the live connection is lost; reset after a good check.
    expect(page).toContain('return () => {\n      clearDeviceCheckRetry();\n      unmountCleanupTimer.current');
    expect(page).toContain('clearDeviceCheckRetry();\n    markDeviceCheckActive(false);');
    expect(page).toContain('setRunning(false); clearDeviceCheckRetry(); markDeviceCheckActive(false);');
    expect(page).toContain('markDeviceCheckActive(true);\n        deviceCheckAttempts.current = 0;');
  });
});

describe('showing the answer as it arrives', () => {
  const app = read('src/renderer/App.tsx');
  it('lets a large piece finish showing line by line before the final text is set', () => {
    expect(app).toContain('answerStream.complete(data.questionId, () => {');
    expect(app).toContain("if (useAppStore.getState().activeAnswerId !== data.questionId) return;\n            store.finishAnswer(");
  });
});
