/** Presentation lifetime only. Never expires an order, mandate or ledger lock. */
export function checkoutWindowSeconds(value?: string): number {
  if (!value || !/^[0-9]{2,4}$/.test(value)) return 600;
  const seconds = Number(value);
  return seconds >= 60 && seconds <= 1800 ? seconds : 600;
}
