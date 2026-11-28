// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MicIndicator, SpeakerIndicator } from '../src/renderer/components/VoiceIndicator';
import { heardSpeaker, HOLD_MS, OPEN_TURN_HOLD_MS, setInterviewerTurnOpen, silenceSpeaker, VoiceMeter, watchSpeaker, type VoiceState } from '../src/renderer/services/voiceActivity';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** 20 ms of a tone at 16 kHz, as the capture delivers it. */
const sound = (amplitude: number): Int16Array => Int16Array.from({ length: 320 }, (_, i) => Math.round(amplitude * 32_767 * Math.sin(2 * Math.PI * 220 * i / 16_000)));
const feed = (meter: VoiceMeter, amplitude: number, batches: number, from: number, hold = HOLD_MS): { at: number; changes: VoiceState[] } => {
  const changes: VoiceState[] = []; let at = from;
  for (let i = 0; i < batches; i += 1) { at += 20; const change = meter.hear(sound(amplitude), at, hold); if (change) changes.push(change); }
  return { at, changes };
};

describe('hearing the interviewer for the speaker waves', () => {
  it('starts on speech, carries on through the gaps between words, then stops', () => {
    const meter = new VoiceMeter();
    const start = feed(meter, 0.2, 3, 0);
    expect(start.changes[0]).toMatchObject({ speaking: true });
    const gap = feed(meter, 0, 25, start.at); // half a second of silence
    expect(meter.current.speaking).toBe(true);
    feed(meter, 0, 10, gap.at);
    expect(meter.current).toEqual({ speaking: false, level: 0 });
  });
  it('keeps waving through a longer pause while the sentence is still going, and not without any sound', () => {
    const meter = new VoiceMeter();
    const start = feed(meter, 0.2, 3, 0, OPEN_TURN_HOLD_MS);
    feed(meter, 0, 60, start.at, OPEN_TURN_HOLD_MS); // 1.2 s pause
    expect(meter.current.speaking).toBe(true);
    const quiet = new VoiceMeter(); feed(quiet, 0, 100, 0, OPEN_TURN_HOLD_MS);
    expect(quiet.current.speaking).toBe(false);
  });
  it('hears quiet speech from a low volume, but not silence, faint hiss or one click', () => {
    const low = new VoiceMeter(); feed(low, 0.006, 5, 0); // about -47 dB
    expect(low.current.speaking).toBe(true);
    const meter = new VoiceMeter();
    expect(feed(meter, 0, 50, 0).changes).toEqual([]);
    expect(feed(meter, 0.001, 200, 1_000).changes).toEqual([]);
    expect(feed(meter, 0.5, 1, 6_000).changes).toEqual([]);
    expect(feed(meter, 0.001, 10, 6_020).changes).toEqual([]);
  });
  it('draws bigger waves for louder sound and changes them at most about 16 times a second', () => {
    const soft = new VoiceMeter(); feed(soft, 0.008, 10, 0);
    const loud = new VoiceMeter(); feed(loud, 0.4, 10, 0);
    expect(soft.current.speaking).toBe(true);
    expect(loud.current.level).toBeGreaterThan(soft.current.level + 0.3);
    const meter = new VoiceMeter(); let at = 0; let changes = 0;
    for (let i = 0; i < 100; i += 1) { at += 20; if (meter.hear(sound(i % 2 ? 0.4 : 0.006), at)) changes += 1; } // two seconds
    expect(changes).toBeLessThanOrEqual(35);
  });
  it('never leaves the waves running when audio stops arriving, even in the middle of a sentence', async () => {
    const seen: boolean[] = [];
    const stop = watchSpeaker((state) => seen.push(state.speaking));
    setInterviewerTurnOpen(true);
    for (let i = 0; i < 3; i += 1) heardSpeaker(sound(0.3));
    expect(seen.at(-1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, OPEN_TURN_HOLD_MS + 800)); // no more audio at all
    expect(seen.at(-1)).toBe(false);
    setInterviewerTurnOpen(false);
    for (let i = 0; i < 3; i += 1) heardSpeaker(sound(0.3));
    silenceSpeaker();
    expect(seen.at(-1)).toBe(false);
    stop();
  });
});

describe('the speaker and microphone pictures on the rail', () => {
  let host: HTMLElement, root: Root;
  beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); silenceSpeaker(); });
  const voice = () => host.querySelector<HTMLElement>('.voice')!;
  it('shows the speaker waves, blinking light and ring while the interviewer speaks, without redrawing the page', async () => {
    await act(async () => { root.render(createElement(SpeakerIndicator, { status: 'active', live: false, talking: false })); });
    expect(voice().dataset.speaking).toBe('false');
    expect(host.querySelectorAll('.voice-wave-live path')).toHaveLength(6);
    expect(host.querySelector('.voice-blink')).not.toBeNull();
    expect(host.querySelector('.voice-sonar')).not.toBeNull();
    for (let i = 0; i < 3; i += 1) heardSpeaker(sound(0.3));
    expect(voice().dataset.speaking).toBe('true');
    expect(Number(voice().style.getPropertyValue('--voice-level'))).toBeGreaterThan(0.5);
    silenceSpeaker();
    expect(voice().dataset.speaking).toBe('false');
  });
  it('searches while the speaker opens, sweeps once it is found and again when the session starts', async () => {
    const show = (status: string, live: boolean) => act(async () => { root.render(createElement(SpeakerIndicator, { status, live, talking: false })); });
    await show('starting', false);
    expect(host.querySelector('.voice-search')).not.toBeNull();
    await show('active', false);
    expect(host.querySelector('.voice-search')).toBeNull();
    const found = host.querySelector('.voice-found');
    await show('active', true);
    expect(host.querySelector('.voice-found')).not.toBe(found); // drawn afresh
    const started = host.querySelector('.voice-found');
    await show('active', false);
    expect(host.querySelector('.voice-found')).toBe(started); // stopping does not replay it
  });
  it('keeps the microphone calm: one sweep when found, no speech animation, and a crossed icon when off', async () => {
    const show = (status: string) => act(async () => { root.render(createElement(MicIndicator, { status })); });
    await show('starting');
    expect(host.querySelector('.voice-search')).not.toBeNull();
    await show('active');
    expect(host.querySelector('.voice-found')).not.toBeNull();
    for (let i = 0; i < 3; i += 1) heardSpeaker(sound(0.3)); // sound never moves the microphone
    expect(voice().hasAttribute('data-speaking')).toBe(false);
    expect(host.querySelector('.voice-wave, .voice-sonar, .voice-blink')).toBeNull();
    expect(host.querySelector('.lucide-mic')).not.toBeNull();
    await show('disabled');
    expect(host.querySelector('.lucide-mic-off')).not.toBeNull();
    expect(host.querySelector('.voice-found')).toBeNull();
  });
});
