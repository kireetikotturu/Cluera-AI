import { z } from 'zod';

export const sessionInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(2).max(100),
  role: z.string().trim().min(2).max(100),
  company: z.string().trim().min(2).max(100),
  interviewType: z.enum(['technical', 'behavioral', 'mixed', 'system-design', 'coding']),
  language: z.string().trim().min(2).max(50),
  answerStyle: z.string().trim().min(2).max(100),
  answerLength: z.enum(['short', 'medium', 'detailed']),
  jobDescription: z.string().max(100_000),
  resumeText: z.string().max(100_000),
  instructions: z.string().max(10_000),
  selectedModel: z.string().trim().min(2).max(100),
  autoAnswer: z.boolean().optional(),
  saveTranscript: z.boolean().optional(),
  interviewUrl: z.string().trim().max(2048).refine((value) => !value || /^https?:\/\//i.test(value) && URL.canParse(value), 'Enter an http or https interview URL.').optional(),
  resumeFileName: z.string().trim().max(500).optional(),
});

export const answerRequestSchema = z.object({
  sessionId: z.string().uuid(),
  question: z.string().trim().min(2).max(5_000),
  mode: z.enum(['default', 'shorter', 'longer', 'technical', 'conversational', 'star']).optional(),
  origin: z.enum(['typed', 'transcript']).optional(),
});

export const audioSourceSchema = z.object({
  id: z.string().trim().min(1).max(200),
  kind: z.enum(['system', 'microphone', 'manual']),
  role: z.enum(['remote_interviewer', 'manual_interviewer', 'local_candidate']),
  label: z.string().trim().min(1).max(200),
  canTriggerAnswers: z.boolean(),
  meetingProvider: z.enum(['Google Meet', 'Microsoft Teams', 'Other']).optional(),
});

export const screenContextSchema = z.object({
  sourceName: z.string().min(1).max(500), capturedAt: z.string().datetime(),
  visibleApplication: z.string().max(500).optional(), visibleText: z.string().max(30_000),
  codeOrProblem: z.string().max(30_000).optional(), errorMessages: z.array(z.string().max(2_000)).max(30),
  constraints: z.array(z.string().max(2_000)).max(50), summary: z.string().max(10_000),
  confidence: z.number().min(0).max(1),
  detectedLanguage: z.string().max(100).optional(), technologies: z.array(z.string().max(100)).max(20).optional(),
  uiDetails: z.string().max(4_000).optional(), currentTask: z.string().max(5_000).optional(),
});

export const shotRequestSchema = z.object({
  kind: z.enum(['tab', 'screen', 'area']),
  sourceId: z.string().min(1).max(200).optional(),
  keepAppVisible: z.boolean().optional(),
});

export const providerModelIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,99}$/);

export const appSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  overlayOpacity: z.number().finite().min(0.35).max(1),
  privateMode: z.boolean(),
  debugMode: z.boolean(),
  demoMode: z.boolean(),
  shortcuts: z.record(z.string().max(80), z.string().max(120)),
  geminiModel: providerModelIdSchema.optional(),
  deepgramModel: providerModelIdSchema.optional(),
});
