'use client';
import { useId } from 'react';
import './unlimited.css';

/** When Admin-given unlimited access ends, or null when it has no end. */
export type UnlimitedAccess = { endsAt: string | null } | null | undefined;

/** An end within two days shows the time too, otherwise the date. */
export function unlimitedUntil(endsAt: string | null, now = Date.now()): string {
  if (endsAt === null) return 'No end date';
  const end = new Date(endsAt);
  const soon = end.getTime() - now < 2 * 86_400_000;
  return `Until ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${soon ? `, ${end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}`;
}

/** One smooth figure-eight in a single stroke, so light can run all the way round it (the same shape as the app). */
const INFINITY_PATH = 'M12 12C9.8 9.1 8 7.7 5.9 7.7C3.5 7.7 1.9 9.6 1.9 12C1.9 14.4 3.5 16.3 5.9 16.3C8 16.3 9.8 14.9 12 12C14.2 9.1 16 7.7 18.1 7.7C20.5 7.7 22.1 9.6 22.1 12C22.1 14.4 20.5 16.3 18.1 16.3C16 16.3 14.2 14.9 12 12Z';

/** The infinity mark, `size` wide. `electric` paints it lavender to sky to teal with a spark running along it. */
export function InfinityIcon({ size = 20, electric = false }: { size?: number; electric?: boolean }) {
  const id = useId();
  return <svg className="infinity-icon" width={size} height={Math.round(size * 14 / 24)} viewBox="0 5 24 14" aria-hidden="true" focusable="false">
    {electric ? <defs><linearGradient id={id} gradientUnits="userSpaceOnUse" x1="2" y1="9" x2="22" y2="15">
      <stop offset="0" stopColor="#c4b5fd" /><stop offset=".38" stopColor="#8b7bff" /><stop offset=".7" stopColor="#38bdf8" /><stop offset="1" stopColor="#5eead4" />
    </linearGradient></defs> : null}
    <path d={INFINITY_PATH} fill="none" stroke={electric ? `url(#${id})` : 'currentColor'} strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round" />
    {electric ? <path className="infinity-spark" d={INFINITY_PATH} pathLength={100} fill="none" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" /> : null}
  </svg>;
}

/** The premium "Unlimited" mark shown wherever hours left would be. */
export function UnlimitedBadge({ large = false }: { large?: boolean }) {
  return <span className={`unlimited-badge${large ? ' large' : ''}`}><InfinityIcon size={large ? 28 : 18} electric />Unlimited</span>;
}
