import { useEffect, useState } from 'react';
import type { AccountView } from '../../shared/accounts';
import App from '../App';
import { useAppStore } from '../stores/appStore';
import { AccountLogin } from './AccountLogin';
import { BrowserHandoff } from './BrowserHandoff';
import { LoadingScreen } from './LoadingScreen';

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
      if (!eventSeen) update({mode:'cluera-staging',state:'unavailable',message:'Desktop account initialization failed. Restart the app.'});
    });
    return () => { alive = false; remove(); };
  }, []);
  const screen = (): JSX.Element => {
    if (!account) return <LoadingScreen title="Opening Cluera AI…" progress={12}/>;
    if (account.mode !== 'cluera-staging') return <main className="startup-error"><h1>Cluera identity unavailable</h1><p>Please restart Cluera AI. If this keeps happening, contact support.</p></main>;
    if (account.state === 'active') return <App key={account.userId} account={account}/>;
    if (account.loading) {
      const openingWorkspace = account.message?.includes('workspace') ?? false;
      return <LoadingScreen title={account.message ?? 'Opening your workspace…'} progress={openingWorkspace ? 55 : 30}/>;
    }
    // A saved sign-in that cannot be checked yet (no network, a service problem) is not signed out: it is tried again.
    if (account.reconnecting) return <ReconnectingAccount onState={setAccount}/>;
    return <AccountLogin state={account} onState={setAccount}/>;
  };
  return <BrowserHandoff owner={account?.state === 'active' ? account.userId ?? 'active' : 'signed-out'}>{screen()}</BrowserHandoff>;
}

function ReconnectingAccount({ onState }: { onState(state: AccountView): void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<AccountView>): void => {
    setBusy(true);
    void action().then(onState).catch(() => undefined).finally(() => setBusy(false));
  };
  return <LoadingScreen title="Connecting to your account…" progress={30}
    detail="You are still signed in. Check your internet connection; Cluera AI keeps trying.">
    <button type="button" className="loading-primary" disabled={busy} onClick={() => run(() => window.accountAPI!.retry())}>Try again now</button>
    <button type="button" className="loading-link" disabled={busy} onClick={() => run(() => window.accountAPI!.logout(false))}>Use another account</button>
  </LoadingScreen>;
}
