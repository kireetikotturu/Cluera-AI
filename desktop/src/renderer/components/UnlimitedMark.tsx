import { useId } from 'react';
import { creditDuration, type UnlimitedAccess } from '../../shared/accountCredits';

/** An end within two days shows the time too, otherwise the date. */
export function unlimitedUntil(endsAt: string | null, now = Date.now()): string {
  if (endsAt === null) return 'No end date';
  const end = new Date(endsAt);
  const soon = end.getTime() - now < 2 * 86_400_000;
  return `Until ${end.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}${soon ? `, ${end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}`;
}
/** When it ends, and that other time is kept for afterwards. */
export function unlimitedNote(access: NonNullable<UnlimitedAccess>): string {
  return `${unlimitedUntil(access.endsAt)}. ${access.savedMilliseconds > 0 ? `Your other ${creditDuration(access.savedMilliseconds)} stays saved for afterwards.` : 'Bought time stays saved for afterwards.'}`;
}

export function InfinityIcon({ size = 18, gold = false }: { size?: number; gold?: boolean }): JSX.Element {
  const id = useId();
  return <svg className="infinity-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {gold ? <defs><linearGradient id={id} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffe7a3"/><stop offset=".55" stopColor="#f5bd45"/><stop offset="1" stopColor="#d9951c"/></linearGradient></defs> : null}
    <path d="M12 12c-2.2-3-4-4.4-6.1-4.4C3.4 7.6 2 9.6 2 12s1.4 4.4 3.9 4.4C8 16.4 9.8 15 12 12s4-4.4 6.1-4.4C20.6 7.6 22 9.6 22 12s-1.4 4.4-3.9 4.4C16 16.4 14.2 15 12 12Z"
      fill="none" stroke={gold ? `url(#${id})` : 'currentColor'} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

/** The premium "Unlimited" mark shown wherever hours left would be. */
export function UnlimitedBadge({ large = false }: { large?: boolean }): JSX.Element {
  return <span className={`unlimited-badge${large ? ' large' : ''}`}><InfinityIcon size={large ? 22 : 13}/>Unlimited</span>;
}
