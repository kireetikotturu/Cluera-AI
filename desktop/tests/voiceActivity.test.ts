// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VoiceIndicator } from '../src/renderer/components/VoiceIndicator';
import { heardAudio, silenceVoice, VoiceMeter, watchVoice, type VoiceState } from '../src/renderer/services/voiceActivity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** 20 ms of a tone at 16 kHz, as the capture delivers it. */
const sound = (amplitude: number): Int16Array => Int16Array.from({ length: 320 }, (_, i) => Math.round(amplitude * 32_767 * Math.sin(2 * Math.PI * 220 * i / 16_000)));
const feed = (meter: VoiceMeter, amplitude: number, batches: number, from: number): { at: number; changes: VoiceState[] } => {
  const changes: VoiceState[] = []; let at = from;
  for (let i = 0; i < batches; i += 1) { at += 20; const change = meter.hear(sound(amplitude), at); if (change) changes.push(change); }
  return { at, changes };
};

describe('hearing speech for the rail waves', () => {
  it('starts on speech, carries on through a short gap between words, then stops', () => {
    const meter = new VoiceMeter();
    const start = feed(meter, 0.2, 3, 0);
    expect(start.changes[0]).toMatchObject({ speaking: true });
    const gap = feed(meter, 0, 12, start.at); // 240 ms of silence
    expect(meter.current.speaking).toBe(true);
    feed(meter, 0, 15, gap.at);
    expect(meter.current).toEqual({ speaking: false, level: 0 });
  });
  it('stays still for a muted microphone, quiet noise and a single click', () => {
    const meter = new VoiceMeter();
    expect(feed(meter, 0, 50, 0).changes).toEqual([]);
    expect(feed(meter, 0.003, 200, 1_000).changes).toEqual([]);
    expect(feed(meter, 0.5, 1, 5_000).changes).toEqual([]);
    expect(feed(meter, 0.003, 10, 5_020).changes).toEqual([]);
  });
  it('draws bigger waves for louder sound and changes them at most about 16 times a second', () => {
    const soft = new VoiceMeter(); feed(soft, 0.012, 10, 0);
    const loud = new VoiceMeter(); feed(loud, 0.4, 10, 0);
    expect(soft.current.speaking).toBe(true);
    expect(loud.current.level).toBeGreaterThan(soft.current.level + 0.3);
    const meter = new VoiceMeter(); let at = 0; let changes = 0;
    for (let i = 0; i < 100; i += 1) { at += 20; if (meter.hear(sound(i % 2 ? 0.4 : 0.015), at)) changes += 1; } // two seconds
    expect(changes).toBeLessThanOrEqual(35);
  });
  it('never leaves the waves running when audio stops arriving, and stops them at once when capture stops', async () => {
    const seen: boolean[] = [];
    const stop = watchVoice('candidate', (state) => seen.push(state.speaking));
    for (let i = 0; i < 3; i += 1) heardAudio('candidate', sound(0.3));
    expect(seen.at(-1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // no more audio at all
    expect(seen.at(-1)).toBe(false);
    for (let i = 0; i < 3; i += 1) heardAudio('candidate', sound(0.3));
    silenceVoice('candidate');
    expect(seen.at(-1)).toBe(false);
    stop();
  });
});

describe('the speaker and microphone pictures on the rail', () => {
  let host: HTMLElement, root: Root;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); silenceVoice('system'); });
  const voice = () => host.querySelector<HTMLElement>('.voice')!;
  it('shows waves while sound is heard, without redrawing the page', async () => {
    await act(async () => { root.render(createElement(VoiceIndicator, { source: 'system', status: 'active', live: false })); });
    expect(voice().dataset.speaking).toBe('false');
    expect(host.querySelectorAll('.voice-wave-live path')).toHaveLength(6);
    for (let i = 0; i < 3; i += 1) heardAudio('system', sound(0.3));
    expect(voice().dataset.speaking).toBe('true');
    expect(Number(voice().style.getPropertyValue('--voice-level'))).toBeGreaterThan(0.5);
    silenceVoice('system');
    expect(voice().dataset.speaking).toBe('false');
  });
  it('searches while a device opens, then sweeps when it is found and again when the session starts', async () => {
    const show = (status: string, live: boolean) => act(async () => { root.render(createElement(VoiceIndicator, { source: 'candidate', status, live })); });
    await show('starting', false);
    expect(host.querySelector('.voice-search')).not.toBeNull();
    await show('active', false);
    expect(host.querySelector('.voice-search')).toBeNull();
    const found = host.querySelector('.voice-found');
    expect(found).not.toBeNull();
    expect(host.querySelector('.voice-mic')).not.toBeNull();
    await show('active', true);
    expect(host.querySelector('.voice-found')).not.toBe(found); // drawn afresh
    const started = host.querySelector('.voice-found');
    await show('active', false);
    expect(host.querySelector('.voice-found')).toBe(started); // stopping does not replay it
    await show('disabled', false);
    expect(host.querySelector('.voice-found')).toBeNull();
  });
});
