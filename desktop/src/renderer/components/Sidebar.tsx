import { History, Home, Plus, Settings, Sparkles } from 'lucide-react';
import { useAppStore, type Page } from '../stores/appStore';

const items: Array<{ page: Page; label: string; icon: typeof Home }> = [
  { page: 'home', label: 'Sessions', icon: Home }, { page: 'create', label: 'New session', icon: Plus },
  { page: 'history', label: 'History', icon: History }, { page: 'settings', label: 'Settings', icon: Settings },
];

export function Sidebar(): JSX.Element {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const provider = useAppStore((s) => s.providerStatus);
  return <aside className="sidebar">
    <nav>{items.map((item) => <button key={item.page} className={page === item.page ? 'active' : ''} onClick={() => setPage(item.page)}><item.icon size={17}/><span>{item.label}</span></button>)}</nav>
    <div className="sidebar-foot">
      <div className="plan"><Sparkles size={15}/><div><strong>{provider?.demoMode ? 'Demo mode' : 'Cloud ready'}</strong><span>{provider?.demoMode ? 'Works without API keys' : 'Providers connected'}</span></div></div>
      <span className="privacy-note">Local-first · private by design</span>
    </div>
  </aside>;
}
