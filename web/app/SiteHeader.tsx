'use client';

import Link from 'next/link';
import { useState } from 'react';

export function SiteHeader({accountEdition=false}:{accountEdition?:boolean}) {
  const [open, setOpen] = useState(false);
  const close = (): void => setOpen(false);
  return <header className="site-header"><Link className="wordmark" href="/" onClick={close}><span aria-hidden="true">C</span><strong>Cluera <em>AI</em></strong></Link>
    <button className="menu-toggle" type="button" aria-label="Toggle navigation" aria-expanded={open} aria-controls="site-navigation" onClick={() => setOpen(!open)}><i/><i/><i/></button>
    <nav id="site-navigation" className={open ? 'open' : ''} aria-label="Primary navigation"><Link href="/#features" onClick={close}>Features</Link><Link href="/#how" onClick={close}>How it works</Link><Link href={accountEdition?'/pricing':'/#pricing'} onClick={close}>Pricing</Link><Link href="/download" onClick={close}>Download</Link><Link href="/setup" onClick={close}>Setup</Link><Link href="/support" onClick={close}>Support</Link>{accountEdition?<Link href="/account" onClick={close}>My account</Link>:null}</nav>
    <a className="button small header-download" href={accountEdition?'/download':'/download/installer'}>Download</a>
  </header>;
}
