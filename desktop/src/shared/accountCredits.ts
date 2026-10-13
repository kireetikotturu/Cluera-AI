/** Renderer-safe reporting, never an entitlement or a client-created currency. */
export interface CreditBucket {
  kind: 'TRIAL'|'RECURRING'|'PACK'|'TEST'|'MANUAL';
  grantedMilliseconds: number; spentMilliseconds: number;
  reservedMilliseconds: number; availableMilliseconds: number;
}
export interface AccountCredits {
  userId: string; serverTime: string; displayName: string;
  availableMilliseconds: number; reservedMilliseconds: number; spentMilliseconds: number;
  buckets: CreditBucket[];
  plans: { tier: string; state: string; paymentState: string; endsAt: string|null; cancelFuture: boolean }[];
  payments: { offerCode: string; state: 'CREATING'|'BOUND'|'UNCERTAIN'|'REJECTED'|'VERIFIED'|'REFUNDED'; createdAt: string }[];
  checkoutAvailable: boolean;
}
export interface CreditsView {
  state: 'empty'|'ready'|'unavailable'; refreshing: boolean;
  snapshot?: AccountCredits; lastSync?: string;
  active: boolean; activeMilliseconds: number;
}
export const emptyCredits = (): CreditsView => ({state:'empty',refreshing:false,active:false,activeMilliseconds:0});
export function creditDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0,milliseconds)/1000), minutes = Math.floor(seconds/60);
  return minutes ? `${Math.floor(minutes/60)}h ${minutes%60}m` : `${seconds}s`;
}
export function allowancePercent(bucket: CreditBucket): number|null {
  return bucket.grantedMilliseconds > 0
    ? Math.min(100,Math.max(0,100*bucket.spentMilliseconds/bucket.grantedMilliseconds)) : null;
}
export const bucketName = {TRIAL:'Lifetime trial',RECURRING:'Current recurring allowance',PACK:'Non-expiring packs',TEST:'Staging test access',MANUAL:'Manual allowance'};
