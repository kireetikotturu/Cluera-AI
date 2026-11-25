const paths = {
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4V8Zm8 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  send: 'M5 12h14M13 6l6 6-6 6',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 4v16l13-8L7 4Z',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  shrink: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
  stop: 'M6 6h12v12H6z',
  copy: 'M9 9h10v11H9V9Zm-4 6V4h10',
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  retry: 'M20 12a8 8 0 1 1-2.5-5.8M20 4v6h-6',
  close: 'M6 6l12 12M18 6 6 18',
  down: 'M12 5v14M6 13l6 6 6-6',
  image: 'M4 5h16v14H4V5Zm0 11 5-5 4 4 3-3 4 4M9 9.5h.01',
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
