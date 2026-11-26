import { X } from 'lucide-react';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import clueraLogo from '../assets/cluera-ai.svg';

/** Where the bar stood last, so it carries on from there when one loading screen replaces another. */
let lastProgress = 0;

/** The one loading screen between starting the app (or signing in) and the dashboard. */
export function LoadingScreen({ title, detail, progress, children }:
  { title: string; detail?: string; progress: number; children?: ReactNode }): JSX.Element {
  const [from] = useState(() => (lastProgress <= progress ? lastProgress : 0));
  useEffect(() => { lastProgress = progress; }, [progress]);
  return <main className="loading-screen">
    <header className="account-login-bar"><span><img className="account-login-logo" src={clueraLogo} alt=""/>Cluera AI</span>
      <button type="button" aria-label="Close Cluera AI" onClick={() => void window.electronAPI?.closeWindow()}><X size={18}/></button></header>
    <section className="loading-card">
      <img className="loading-logo" src={clueraLogo} alt=""/>
      <div role="status" aria-live="polite"><h1>{title}</h1>{detail && <p>{detail}</p>}</div>
      <div className="loading-bar" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
        style={{ '--from': `${from}%`, '--to': `${progress}%` } as CSSProperties}><span/></div>
      {children && <div className="loading-actions">{children}</div>}
    </section>
  </main>;
}
