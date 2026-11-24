/** Estimated provider cost for the Admin customer view.
 *
 * Providers do not bill per customer, so this is an estimate: the tokens and audio minutes the relay
 * recorded for each customer, multiplied by public list prices. Prices live here (one place) so they can
 * be corrected when a provider changes them. Nothing here touches what a customer is charged. */
export interface UsageRow {
  provider: string; model: string; calls: number;
  inputTokens: number; outputTokens: number; thinkingTokens: number; audioMs: number;
}
export interface TokenRate { inputPerMillion: number; outputPerMillion: number }
export const DEEPGRAM_USD_PER_MINUTE = 0.0077;
export const DEFAULT_USD_TO_INR = 88;

/** US dollars per one million tokens. Thinking tokens are billed like output tokens. */
export function tokenRate(provider: string, model: string): TokenRate {
  const name = model.toLowerCase();
  if (provider === 'gemini') {
    if (name.includes('lite')) return { inputPerMillion: 0.10, outputPerMillion: 0.40 };
    if (name.includes('pro')) return { inputPerMillion: 1.25, outputPerMillion: 10 };
    return { inputPerMillion: 0.30, outputPerMillion: 2.50 };
  }
  if (provider === 'openai') return { inputPerMillion: 1.25, outputPerMillion: 10 };
  if (provider === 'anthropic') return { inputPerMillion: 3, outputPerMillion: 15 };
  return { inputPerMillion: 0.30, outputPerMillion: 2.50 };
}

export function usdToInr(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.CLUERA_USD_INR);
  return Number.isFinite(value) && value >= 50 && value <= 200 ? value : DEFAULT_USD_TO_INR;
}

export interface CostedRow extends UsageRow { costUsd: number; costInr: number }
const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

export function costRow(row: UsageRow, rate = usdToInr()): CostedRow {
  let usd = 0;
  if (row.provider === 'deepgram') usd = (row.audioMs / 60_000) * DEEPGRAM_USD_PER_MINUTE;
  else {
    const price = tokenRate(row.provider, row.model);
    usd = (row.inputTokens / 1e6) * price.inputPerMillion + ((row.outputTokens + row.thinkingTokens) / 1e6) * price.outputPerMillion;
  }
  return { ...row, costUsd: round(usd), costInr: round(usd * rate) };
}

export function costRows(rows: UsageRow[], rate = usdToInr()) {
  const costed = rows.map(row => costRow(row, rate));
  return { rows: costed, totalUsd: round(costed.reduce((sum, row) => sum + row.costUsd, 0)), totalInr: round(costed.reduce((sum, row) => sum + row.costInr, 0)) };
}

/** What the Admin page shows next to every estimate, so the assumptions are never hidden. */
export function costAssumptions(rate = usdToInr()) {
  return {
    usdToInr: rate, deepgramUsdPerMinute: DEEPGRAM_USD_PER_MINUTE,
    gemini: { flash: tokenRate('gemini', 'flash'), flashLite: tokenRate('gemini', 'flash-lite'), pro: tokenRate('gemini', 'pro') },
    openai: tokenRate('openai', ''), anthropic: tokenRate('anthropic', ''),
  };
}

const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };
function usageRows(raw: unknown): UsageRow[] {
  return Array.isArray(raw) ? raw.map((r: Record<string, unknown>) => ({
    provider: String(r?.provider ?? ''), model: String(r?.model ?? ''), calls: num(r?.calls),
    inputTokens: num(r?.inputTokens), outputTokens: num(r?.outputTokens), thinkingTokens: num(r?.thinkingTokens), audioMs: num(r?.audioMs),
  })) : [];
}

/** Turns the database report into what the Admin page shows: the same numbers plus estimated cost. */
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
