/** Provider cost for the Admin customer view.
 *
 * Every request is priced in the database from the usage the provider itself reported and the provider's published
 * price on that day (the AI costs tab lists both). Here the dollars are only converted to rupees.
 * Nothing here touches what a customer is charged. */
export interface UsageRow {
  provider: string; model: string; calls: number;
  inputTokens: number; outputTokens: number; thinkingTokens: number; audioMs: number;
  /** US dollars for the priced requests; requests whose model has no price yet are counted in `unpriced`. */
  costUsd: number; unpriced: number;
}
export const DEFAULT_USD_TO_INR = 88;

export function usdToInr(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.CLUERA_USD_INR);
  return Number.isFinite(value) && value >= 50 && value <= 200 ? value : DEFAULT_USD_TO_INR;
}

export interface CostedRow extends UsageRow { costInr: number }
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function costRows(rows: UsageRow[], rate = usdToInr()) {
  const costed: CostedRow[] = rows.map(row => ({ ...row, costUsd: round(row.costUsd), costInr: round(row.costUsd * rate) }));
  return {
    rows: costed, unpriced: rows.reduce((sum, row) => sum + row.unpriced, 0),
    totalUsd: round(rows.reduce((sum, row) => sum + row.costUsd, 0)), totalInr: round(rows.reduce((sum, row) => sum + row.costUsd * rate, 0)),
  };
}

/** What the Admin page shows next to every amount. */
export function costAssumptions(rate = usdToInr()) {
  return { usdToInr: rate };
}

const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };
function usageRows(raw: unknown): UsageRow[] {
  return Array.isArray(raw) ? raw.map((r: Record<string, unknown>) => ({
    provider: String(r?.provider ?? ''), model: String(r?.model ?? ''), calls: num(r?.calls),
    inputTokens: num(r?.inputTokens), outputTokens: num(r?.outputTokens), thinkingTokens: num(r?.thinkingTokens), audioMs: num(r?.audioMs),
    costUsd: num(r?.costUsd), unpriced: num(r?.unpriced),
  })) : [];
}

/** Turns the database report into what the Admin page shows: the same numbers, with rupees. */
export function shapeUsageReport(report: Record<string, any>, rate = usdToInr()) {
  const withCost = (raw: unknown) => costRows(usageRows(raw), rate);
  const out: Record<string, unknown> = { assumptions: costAssumptions(rate), observedAt: new Date().toISOString() };
  if (Array.isArray(report.customers)) {
    out.overall = { customerCount: num(report.overall?.customerCount), activeNow: num(report.overall?.activeNow), usedMs: num(report.overall?.usedMs), usage: withCost(report.overall?.usage) };
    out.customers = report.customers.map((c: Record<string, any>) => ({
      userId: String(c.userId), email: String(c.email ?? ''), state: String(c.state ?? ''), createdAt: c.createdAt ?? null,
      usedMs: num(c.usedMs), activeNow: c.activeNow === true, lastActiveAt: c.lastActiveAt ?? null, usage: withCost(c.usage),
    }));
  }
  if (report.customer) {
    const c = report.customer;
    out.customer = {
      userId: String(c.userId), email: String(c.email ?? ''), state: String(c.state ?? ''), createdAt: c.createdAt ?? null,
      usedMs: num(c.usedMs), activeNow: c.activeNow === true, activeSince: c.activeSince ?? null,
      sessionCount: num(c.sessionCount), lastActiveAt: c.lastActiveAt ?? null,
    };
    out.adminReducedMs = num(report.adminReducedMs);
    out.models = withCost(report.models);
    out.models30d = withCost(report.models30d);
    out.sessions = (Array.isArray(report.sessions) ? report.sessions : []).map((s: Record<string, any>) => ({
      runId: String(s.runId), startedAt: s.startedAt ?? null, state: String(s.state ?? ''), usedMs: num(s.usedMs), usage: withCost(s.usage),
    }));
  }
  return out;
}
