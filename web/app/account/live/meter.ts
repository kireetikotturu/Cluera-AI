/** The microphone's level, shared between the capture (many times a second) and the screen without re-drawing the page. */
export interface Meter {
  value: number;
  set(level: number): void;
  subscribe(listener: (level: number) => void): () => void;
}

export function createMeter(): Meter {
  const listeners = new Set<(level: number) => void>();
  const meter: Meter = {
    value: 0,
    set(level) { meter.value = level; for (const listener of [...listeners]) listener(level); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return meter;
}
