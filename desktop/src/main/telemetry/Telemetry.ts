import type { TelemetrySnapshot } from '../../shared/types';

export class Telemetry {
  private marks = new Map<string, number>();
  mark(name: string): void { this.marks.set(name, performance.now()); }
  elapsed(from: string, to?: string): number {
    const start = this.marks.get(from) ?? performance.now();
    const end = to ? (this.marks.get(to) ?? performance.now()) : performance.now();
    return Math.max(0, Math.round(end - start));
  }
  snapshot(): TelemetrySnapshot {
    return {
      turnDetectionLatency: this.elapsed('turnStart', 'turnEnd'),
      intentLatency: this.elapsed('intentStart', 'intentEnd'),
      retrievalLatency: this.elapsed('retrievalStart', 'retrievalEnd'),
      llmTimeToFirstToken: this.elapsed('llmStart', 'firstToken'),
      totalQuestionToAnswerLatency: this.elapsed('questionStart'),
    };
  }
}
