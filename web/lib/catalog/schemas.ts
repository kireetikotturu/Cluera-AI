import { z } from 'zod';

export const planCodeSchema = z.enum(['one_device', 'two_devices']);
export const priceUpdateSchema = z.object({
  originalPriceMinor: z.number().int().min(0).max(1_000_000_000),
  sellingPriceMinor: z.number().int().min(0).max(1_000_000_000),
  description: z.string().trim().max(500),
  enabled: z.boolean(),
  featured: z.boolean(),
}).refine((value) => value.sellingPriceMinor <= value.originalPriceMinor, {
  message: 'Selling price cannot exceed original price.', path: ['sellingPriceMinor'],
});

export const modelSchema = z.object({
  provider: z.enum(['gemini', 'deepgram']),
  modelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/),
  displayName: z.string().trim().min(2).max(80),
  description: z.string().trim().max(240),
  enabled: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
});

export interface PricingPlan {
  code: 'one_device' | 'two_devices';
  name: string;
  deviceCount: number;
  originalPriceMinor: number;
  sellingPriceMinor: number;
  currency: string;
  description: string;
  enabled: boolean;
  featured: boolean;
  sortOrder: number;
}

export interface ProviderModel {
  provider: 'gemini' | 'deepgram';
  modelId: string;
  displayName: string;
  description: string;
  enabled: boolean;
  sortOrder: number;
}
