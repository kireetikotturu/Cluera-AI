import { AccountBoot } from './AccountBoot';
/** Shown at once when the account page is opened. It has the same frame as the page itself, so the page does not shift when it appears. */
export default function Loading() {
  return <main className="account-page" aria-busy="true"><h1 className="account-page-title">Your Cluera account</h1><AccountBoot/></main>;
}
