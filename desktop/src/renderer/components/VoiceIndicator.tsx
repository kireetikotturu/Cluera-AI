import { useEffect, useId, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { watchVoice, type VoiceSource } from '../services/voiceActivity';

/** The six lines of the audio-output icon, the same shape as before, which dance while sound is heard. */
const BARS: ReadonlyArray<readonly [number, number, number]> = [[2, 10, 13], [6, 6, 17], [10, 3, 21], [14, 8, 15], [18, 5, 18], [22, 10, 13]];
const lines = (): JSX.Element[] => BARS.map(([x, top, bottom]) => <path key={x} d={`M${x} ${top}V${bottom}`}/>);
const frame = { x: 1.2, y: 1.2, width: 29.6, height: 29.6, rx: 9, pathLength: 100 };

/** The picture inside the rail's speaker and microphone buttons: a sweep when the device is found (and again when the
 * session starts), then waves while sound is heard on it. The buttons, their status dots and what they do are unchanged. */
export function VoiceIndicator({ source, status, live }: { source: VoiceSource; status: string; live: boolean }): JSX.Element {
  const host = useRef<HTMLSpanElement>(null);
  const edge = useId();
  const wave = useId();
  const [starts, setStarts] = useState(0);
  useEffect(() => { if (live) setStarts((count) => count + 1); }, [live]);
  // Written straight onto the element: loudness changes many times a second and must not re-render the live page.
  useEffect(() => watchVoice(source, ({ speaking, level }) => {
    const element = host.current;
    if (!element) return;
    element.dataset.speaking = String(speaking);
    element.style.setProperty('--voice-level', String(level));
  }), [source]);
  return <span ref={host} className={`voice voice-${source}`} data-speaking="false" aria-hidden="true">
    <span className="voice-glow"/>
    <svg className="voice-edge" viewBox="0 0 32 32">
      <defs><linearGradient id={edge} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="30" y2="30"><stop offset="0" className="voice-stop-a"/><stop offset="1" className="voice-stop-b"/></linearGradient></defs>
      {status === 'starting' ? <rect className="voice-search" {...frame} stroke={`url(#${edge})`}/> : null}
      {status === 'active' ? <rect key={starts} className="voice-found" {...frame} stroke={`url(#${edge})`}/> : null}
    </svg>
    {source === 'system' ? <svg className="voice-wave" width="15" height="15" viewBox="0 0 24 24">
      <defs><linearGradient id={wave} gradientUnits="userSpaceOnUse" x1="2" y1="12" x2="22" y2="12"><stop offset="0" className="voice-stop-a"/><stop offset="1" className="voice-stop-b"/></linearGradient></defs>
      <g className="voice-wave-idle">{lines()}</g>
      <g className="voice-wave-live" stroke={`url(#${wave})`}>{lines()}</g>
    </svg> : <>
      <span className="voice-ripple"/><span className="voice-ripple second"/>
      <Mic className="voice-mic" size={15}/>
    </>}
  </span>;
}
