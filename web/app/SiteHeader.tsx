'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {AdminRoleLink} from './account/AdminRoleNavigation';
import {Wordmark} from './BrandMark';

export function SiteHeader({accountEdition=false}:{accountEdition?:boolean}) {
  const [open, setOpen] = useState(false), [scrolled, setScrolled] = useState(false);
  const close = (): void => setOpen(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return <div className={`site-header-shell${scrolled ? ' scrolled' : ''}`}><header className="site-header"><Link className="wordmark" href="/" onClick={close}><Wordmark/></Link>
    <button className="menu-toggle" type="button" aria-label="Toggle navigation" aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(!open)}><i/><i/><i/></button>
    <nav id="site-navigation" className={open ? 'open' : ''} aria-label="Primary navigation"><Link href="/#features" onClick={close}>Features</Link><Link href="/#how" onClick={close}>How it works</Link><Link href={accountEdition?'/pricing':'/#pricing'} onClick={close}>Pricing</Link><Link href="/download" onClick={close}>Download</Link><Link href="/setup" onClick={close}>Setup</Link><Link href="/support" onClick={close}>Support</Link>{accountEdition?<a className="mobile-only" href="/account/live" onClick={close}>Live session</a>:null}{accountEdition?<Link href="/account" onClick={close}>My account</Link>:null}{accountEdition?<AdminRoleLink onClick={close}/>:null}</nav>
    <a className="button small header-download" href={accountEdition?'/download':'/download/installer'}>Download</a>
  </header></div>;
}
