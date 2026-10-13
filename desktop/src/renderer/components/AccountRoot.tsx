import { useEffect, useState } from 'react';
import type { AccountView } from '../../shared/accounts';
import App from '../App';
import { useAppStore } from '../stores/appStore';
import { AccountLogin } from './AccountLogin';

/** Safe state subscription only; no token storage, polling or direct Auth calls. */
export function AccountRoot(): JSX.Element {
  const [account, setAccount] = useState<AccountView | null>(null);
  useEffect(() => {
    const api = window.accountAPI;
    if (!api) { setAccount({ mode:'cluera-staging',state:'unavailable',message:'The secure Cluera desktop bridge is unavailable. Restart the application.' }); return; }
    let alive = true, eventSeen = false;
    const update = (state: AccountView) => {
      if (!alive) return;
      if (state.mode === 'cluera-staging' && state.state !== 'active') useAppStore.setState(useAppStore.getInitialState(), true);
      setAccount(state);
    };
    const remove = api.onStatus(state => { eventSeen = true; update(state); });
    void api.status().then(state => { if (!eventSeen) update(state); }).catch(() => {
      update({mode:'cluera-staging',state:'unavailable',message:'Desktop account initialization failed. Restart the app.'});
    });
    return () => { alive = false; remove(); };
  }, []);
  if (!account) return <main className="startup-error"><h1>Opening Cluera AI…</h1></main>;
  if (account.mode !== 'cluera-staging') return <main className="startup-error"><h1>Cluera identity unavailable</h1><p>Restart this Cluera TEST application. No License fallback is available.</p></main>;
  if (account.state === 'active') return <App key={account.userId} account={account}/>;
  return <AccountLogin state={account} onState={setAccount}/>;
}
