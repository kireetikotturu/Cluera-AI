import { useEffect, useState } from 'react';
import { emptyCredits, type CreditsView } from '../../shared/accountCredits';

const MINUTE = 60_000;

/** Time left, as a small ring in the live side rail. Server balances arrive every 30 seconds while a
 * session runs; between them the ring counts down locally. It only displays; it never authorizes work. */
export function LiveTimeRing(): JSX.Element | null {
  const [view, setView] = useState<CreditsView>(emptyCredits());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const api = window.accountAPI?.credits;
    if (!api) return undefined;
    let alive = true;
    const accept = (next: CreditsView): void => { if (alive) setView(next); };
    const unsubscribe = api.onChange(accept);
    void api.refresh().then(accept).catch(() => undefined);
    return () => { alive = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), view.active ? 5_000 : 30_000);
    return () => clearInterval(timer);
  }, [view.active]);

  const snapshot = view.snapshot;
  if (!snapshot) return <span className="live-time-ring pending" title="Syncing your time" aria-label="Syncing your time left"><i/></span>;
  // Unspent time = free time plus the slice currently held for this run, minus what has run since the last sync.
  const sinceSync = view.active && view.lastSync ? Math.max(0, now - Date.parse(view.lastSync)) : 0;
  const left = Math.max(0, snapshot.availableMilliseconds + snapshot.reservedMilliseconds - sinceSync);
  const capacity = Math.max(left, snapshot.buckets.reduce((sum, bucket) => sum + (bucket.grantedMilliseconds > 0 ? bucket.grantedMilliseconds : 0), 0), MINUTE);
  const fraction = Math.min(1, left / capacity);
  const minutes = Math.floor(left / MINUTE);
  const level = minutes <= 3 ? 'critical' : minutes <= 10 ? 'low' : 'ok';
  const radius = 15, circumference = 2 * Math.PI * radius;
  const hours = Math.floor(minutes / 60);
  const label = `${hours ? `${hours} hour${hours === 1 ? '' : 's'} ` : ''}${minutes % 60} minute${minutes % 60 === 1 ? '' : 's'} left`;
  return <span className={`live-time-ring ${level}`} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <circle className="ring-track" cx="18" cy="18" r={radius}/>
      <circle className="ring-value" cx="18" cy="18" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fraction)} transform="rotate(-90 18 18)"/>
    </svg>
    <b>{hours ? <>{hours}<small>h</small></> : <>{minutes}<small>m</small></>}</b>
    {hours ? <em>{String(minutes % 60).padStart(2, '0')}m</em> : null}
  </span>;
}
