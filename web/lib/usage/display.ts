/** Snapshot formatting only: never a client clock or an authorization decision. */
export function usageDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
