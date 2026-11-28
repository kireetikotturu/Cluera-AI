import { useEffect, useId, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { setInterviewerTurnOpen, watchSpeaker } from '../services/voiceActivity';

/** The six lines of the audio-output icon, which dance while the interviewer speaks. */
const BARS: ReadonlyArray<readonly [number, number, number]> = [[2, 10, 13], [6, 6, 17], [10, 3, 21], [14, 8, 15], [18, 5, 18], [22, 10, 13]];
const lines = (): JSX.Element[] => BARS.map(([x, top, bottom]) => <path key={x} d={`M${x} ${top}V${bottom}`}/>);
const frame = { x: 1.2, y: 1.2, width: 29.6, height: 29.6, rx: 9, pathLength: 100 };

/** A light drawn round a rail audio button: searching while the device opens, then one sweep once it is found
 * (a new `sweep` number plays it again). */
function DeviceEdge({ status, sweep }: { status: string; sweep: number }): JSX.Element {
  const paint = useId();
  return <svg className="voice-edge" viewBox="0 0 32 32">
    <defs><linearGradient id={paint} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="30" y2="30"><stop offset="0" className="voice-stop-a"/><stop offset="1" className="voice-stop-b"/></linearGradient></defs>
    {status === 'starting' ? <rect className="voice-search" {...frame} stroke={`url(#${paint})`}/> : null}
    {status === 'active' ? <rect key={sweep} className="voice-found" {...frame} stroke={`url(#${paint})`}/> : null}
  </svg>;
}

/** The speaker button's picture. While the interviewer speaks: dancing bars, a softly blinking light and a ring.
 * `talking` is the speech service's word that their sentence is still going. */
export function SpeakerIndicator({ status, live, talking }: { status: string; live: boolean; talking: boolean }): JSX.Element {
  const host = useRef<HTMLSpanElement>(null);
  const wave = useId();
  const [starts, setStarts] = useState(0);
  useEffect(() => { if (live) setStarts((count) => count + 1); }, [live]);
  useEffect(() => { setInterviewerTurnOpen(talking); return () => setInterviewerTurnOpen(false); }, [talking]);
  // Written straight onto the element: loudness changes many times a second and must not re-render the live page.
  useEffect(() => watchSpeaker(({ speaking, level }) => {
    const element = host.current;
    if (!element) return;
    element.dataset.speaking = String(speaking);
    element.style.setProperty('--voice-level', String(level));
  }), []);
  return <span ref={host} className="voice voice-speaker" data-speaking="false" aria-hidden="true">
    <span className="voice-glow"><span className="voice-blink"/></span>
    <span className="voice-sonar"/>
    <DeviceEdge status={status} sweep={starts}/>
    <svg className="voice-wave" width="15" height="15" viewBox="0 0 24 24">
      <defs><linearGradient id={wave} gradientUnits="userSpaceOnUse" x1="2" y1="12" x2="22" y2="12"><stop offset="0" className="voice-stop-a"/><stop offset="1" className="voice-stop-b"/></linearGradient></defs>
      <g className="voice-wave-idle">{lines()}</g>
      <g className="voice-wave-live" stroke={`url(#${wave})`}>{lines()}</g>
    </svg>
  </span>;
}

/** The microphone button's picture: one green sweep when the microphone is found, then it stays calm and green. */
export function MicIndicator({ status }: { status: string }): JSX.Element {
  return <span className="voice voice-microphone" aria-hidden="true">
    <DeviceEdge status={status} sweep={0}/>
    {status === 'disabled' ? <MicOff className="voice-mic" size={15}/> : <Mic className="voice-mic" size={15}/>}
  </span>;
}
