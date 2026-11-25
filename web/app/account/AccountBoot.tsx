/** What the account page shows while it loads and while the sign-in is checked: a card the size of the sign-in card, so the page never jumps. */
export function AccountBoot() {
  return <div className="acct-boot" role="status" aria-label="Checking your account"><div className="acct-boot-card" aria-hidden="true"/></div>;
}
