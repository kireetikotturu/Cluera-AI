'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

/** Thin top loading bar for page changes, like modern SaaS apps. Purely visual. */
function Bar() {
  const pathname = usePathname(), search = useSearchParams();
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.('a');
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const url = new URL(link.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      setState('loading');
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  useEffect(() => {
    setState(current => (current === 'loading' ? 'done' : current));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 450);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [pathname, search]);
  return <div className={`nav-progress nav-progress-${state}`} aria-hidden="true"><span /></div>;
}
export function NavProgress() {
  return <Suspense fallback={null}><Bar /></Suspense>;
}
