export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowBounds extends WorkArea {}

export interface WindowSize {
  width: number;
  height: number;
}

export const FLOATING_LAUNCHER_SIZE = 44;
export const SESSION_TOP_INSET = 6;
export const DEFAULT_SESSION_WINDOW_SIZE: WindowSize = { width: 1200, height: 800 };

export function dashboardWindowBounds(workArea: WorkArea): WindowBounds {
  if (!Number.isFinite(workArea.width) || !Number.isFinite(workArea.height) || workArea.width <= 0 || workArea.height <= 0) {
    return {
      x: Number.isFinite(workArea.x) ? workArea.x : 0,
      y: (Number.isFinite(workArea.y) ? workArea.y : 0) + SESSION_TOP_INSET,
      ...DEFAULT_SESSION_WINDOW_SIZE,
    };
  }
  const width = Math.max(420, Math.round(workArea.width * 0.45));
  const height = Math.max(360, Math.round(workArea.height * 0.8));
  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + SESSION_TOP_INSET,
  };
}

export function sessionWindowBounds(workArea: WorkArea): WindowBounds {
  if (!Number.isFinite(workArea.width) || !Number.isFinite(workArea.height) || workArea.width <= 0 || workArea.height <= 0) {
    return {
      x: Number.isFinite(workArea.x) ? workArea.x : 0,
      y: (Number.isFinite(workArea.y) ? workArea.y : 0) + SESSION_TOP_INSET,
      ...DEFAULT_SESSION_WINDOW_SIZE,
    };
  }
  const width = Math.max(420, Math.round(workArea.width * 0.4));
  const height = Math.max(360, Math.round(workArea.height * 0.7));
  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + SESSION_TOP_INSET,
  };
}

export function floatingLauncherBounds(workArea: WorkArea, size = FLOATING_LAUNCHER_SIZE, topInset = 6): WindowBounds {
  return {
    width: size,
    height: size,
    x: workArea.x + Math.round((workArea.width - size) / 2),
    y: workArea.y + topInset,
  };
}

export function diagonalResizeBounds(
  origin: WindowBounds,
  deltaX: number,
  deltaY: number,
  minimum: WindowSize,
  maximum: WindowSize,
): WindowBounds {
  const requestedDelta = Math.abs(deltaX) >= Math.abs(deltaY) ? deltaX : deltaY;
  const minimumDelta = Math.max(minimum.width - origin.width, minimum.height - origin.height);
  const maximumDelta = Math.min(maximum.width - origin.width, maximum.height - origin.height);
  const appliedDelta = Math.max(minimumDelta, Math.min(maximumDelta, Math.round(requestedDelta)));
  return {
    x: origin.x,
    y: origin.y,
    width: origin.width + appliedDelta,
    height: origin.height + appliedDelta,
  };
}
