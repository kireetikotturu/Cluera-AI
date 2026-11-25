/** The Admin "AI costs" report. The database prices every request from the provider's own reported usage and adds it
 * all up; this only checks the query and makes the numbers safe for the page. */
import { z } from 'zod';
import { usdToInr } from './usageCost';

/** A period (both ends optional) and the Admin's time zone for the day-by-day totals. */
export const aiCostRange = z.object({
  from: z.iso.datetime({ offset: true }).nullable(),
  to: z.iso.datetime({ offset: true }).nullable(),
  tz: z.string().max(64).regex(/^[A-Za-z0-9_+\-/]+$/).nullable(),
}).strict();

export interface AiModelCost {
  provider: string; model: string; requestedAs: string[]; requests: number; answers: number; otherRequests: number;
  inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; thinkingTokens: number; audioMs: number;
  costUsd: number; unpriced: number; estimated: number;
}
export interface AiCustomerCost {
  userId: string; email: string; costUsd: number; answers: number; audioMs: number; unpriced: number;
  sessions: number; sessionMs: number; sessionCostUsd: number; running: boolean; lastSessionAt: string | null;
}
export interface AiSessionCost {
  userId: string; email: string; device: string; startedAt: string; endedAt: string | null; running: boolean;
  sessionMs: number; costUsd: number; answers: number; audioMs: number; unpriced: number; models: string[];
}
export interface AiDayCost { day: string; costUsd: number; answers: number; audioMs: number }
export interface AiProviderDay { day: string; provider: string; requests: number; inputTokens: number; cachedTokens: number; outputTokens: number; audioMs: number; costUsd: number }
export interface AiPrice {
  provider: string; model: string; from: string; longAbove: number | null; input: number | null; cached: number | null; cacheWrite: number | null;
  output: number | null; longInput: number | null; longOutput: number | null; audioMinute: number | null; note: string;
}
export interface AiCostTotals {
  costUsd: number; answers: number; otherRequests: number; audioMs: number; unpriced: number; estimated: number;
  customers: number; sessions: number; sessionMs: number; sessionCostUsd: number; liveNow: number;
}
export interface AiCostReport {
  observedAt: string; usdToInr: number; timeZone: string; trackingSince: string | null; totals: AiCostTotals;
  models: AiModelCost[]; customers: AiCustomerCost[]; sessions: AiSessionCost[]; days: AiDayCost[]; providerDays: AiProviderDay[]; prices: AiPrice[];
}

type Row = Record<string, unknown>;
const num = (value: unknown): number => { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0; };
const priceOr = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const time = (value: unknown): string | null => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const list = <T>(value: unknown, shape: (row: Row) => T): T[] => (Array.isArray(value) ? value.map(item => shape((item ?? {}) as Row)) : []);
const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

export function shapeAiCostReport(report: Row, rate = usdToInr()): AiCostReport {
  const totals = (report.totals ?? {}) as Row;
  return {
    observedAt: new Date().toISOString(), usdToInr: rate, timeZone: text(report.timeZone) || 'UTC', trackingSince: time(report.trackingSince),
    totals: {
      costUsd: num(totals.costUsd), answers: num(totals.answers), otherRequests: num(totals.otherRequests), audioMs: num(totals.audioMs),
      unpriced: num(totals.unpriced), estimated: num(totals.estimated), customers: num(totals.customers), sessions: num(totals.sessions),
      sessionMs: num(totals.sessionMs), sessionCostUsd: num(totals.sessionCostUsd), liveNow: num(totals.liveNow),
    },
    models: list(report.models, row => ({
      provider: text(row.provider), model: text(row.model), requestedAs: names(row.requestedAs), requests: num(row.requests), answers: num(row.answers),
      otherRequests: num(row.otherRequests), inputTokens: num(row.inputTokens), cachedTokens: num(row.cachedTokens), cacheWriteTokens: num(row.cacheWriteTokens),
      outputTokens: num(row.outputTokens), thinkingTokens: num(row.thinkingTokens), audioMs: num(row.audioMs), costUsd: num(row.costUsd),
      unpriced: num(row.unpriced), estimated: num(row.estimated),
    })),
    customers: list(report.customers, row => ({
      userId: text(row.userId), email: text(row.email), costUsd: num(row.costUsd), answers: num(row.answers), audioMs: num(row.audioMs),
      unpriced: num(row.unpriced), sessions: num(row.sessions), sessionMs: num(row.sessionMs), sessionCostUsd: num(row.sessionCostUsd),
      running: row.running === true, lastSessionAt: time(row.lastSessionAt),
    })),
    sessions: list(report.sessions, row => ({
      userId: text(row.userId), email: text(row.email), device: row.device === 'web' ? 'web' : 'windows', startedAt: time(row.startedAt) ?? '',
      endedAt: time(row.endedAt), running: row.running === true, sessionMs: num(row.sessionMs), costUsd: num(row.costUsd), answers: num(row.answers),
      audioMs: num(row.audioMs), unpriced: num(row.unpriced), models: names(row.models),
    })),
    days: list(report.days, row => ({ day: text(row.day), costUsd: num(row.costUsd), answers: num(row.answers), audioMs: num(row.audioMs) })),
    providerDays: list(report.providerDays, row => ({
      day: text(row.day), provider: text(row.provider), requests: num(row.requests), inputTokens: num(row.inputTokens), cachedTokens: num(row.cachedTokens),
      outputTokens: num(row.outputTokens), audioMs: num(row.audioMs), costUsd: num(row.costUsd),
    })),
    prices: list(report.prices, row => ({
      provider: text(row.provider), model: text(row.model), from: text(row.from), longAbove: priceOr(row.longAbove), input: priceOr(row.input),
      cached: priceOr(row.cached), cacheWrite: priceOr(row.cacheWrite), output: priceOr(row.output), longInput: priceOr(row.longInput),
      longOutput: priceOr(row.longOutput), audioMinute: priceOr(row.audioMinute), note: text(row.note),
    })),
  };
}
