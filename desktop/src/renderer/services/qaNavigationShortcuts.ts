export interface QaNavigationKey {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  code: string;
  key: string;
}

export function qaNavigationDelta(event: QaNavigationKey, editableTarget: boolean): -1 | 0 | 1 {
  if (editableTarget || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return 0;
  const key = event.key.toLowerCase();
  if (event.code === 'KeyA' || key === 'a') return -1;
  if (event.code === 'KeyD' || key === 'd') return 1;
  return 0;
}
