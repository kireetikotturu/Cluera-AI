/** Renderer-safe state only. Tokens and provider credentials are never part of IPC. */
export interface AccountView {
  mode: 'legacy' | 'cluera-staging';
  state: 'signed-out' | 'checking' | 'active' | 'unavailable' | 'suspended';
  userId?: string;
  email?: string;
  availableMilliseconds?: number;
  reservedMilliseconds?: number;
  spentMilliseconds?: number;
  message?: string;
  /** The saved sign-in is being renewed after a network or service problem; it has not ended. */
  reconnecting?: boolean;
  /** The app is opening the account: show the loading screen, not the sign-in form. */
  loading?: boolean;
}
export interface AccountLogin { email: string; password: string }
export interface AccountAuthOptions { google: 'enabled' | 'disabled' | 'unavailable' }
export type AccountWebAction = 'signup' | 'reset-password' | 'dashboard' | 'credits';
export interface AccountDesktopAPI {
  credits: {
    refresh():Promise<import('./accountCredits').CreditsView>;
    onChange(callback:(view:import('./accountCredits').CreditsView)=>void):()=>void;
  };
  context: {
    list():Promise<import('./accountContext').ContextSnapshot>;
    select(ids:string[]):Promise<import('./accountContext').ContextSnapshot>;
    read(id:string):Promise<import('./accountContext').ContextDocument>;
    change(input:import('./accountContext').ContextCommand):Promise<import('./accountContext').ContextSnapshot>;
    retry():Promise<import('./accountContext').ContextSnapshot>;
    importFile(kind:import('./accountContext').ContextDocument['kind']):Promise<import('./accountContext').ContextSnapshot|null>;
  };
  /** Sessions run from the website on a phone (read only). */
  phoneSessions: {
    list():Promise<import('./phoneSessions').PhoneSessionSummary[]>;
    read(id:string):Promise<import('./phoneSessions').PhoneSessionDetail>;
  };
  status(): Promise<AccountView>;
  authOptions(): Promise<AccountAuthOptions>;
  login(input: AccountLogin): Promise<AccountView>;
  google():Promise<AccountView>;
  retry(): Promise<AccountView>;
  logout(allDevices: boolean): Promise<AccountView>;
  openWeb(action: AccountWebAction): Promise<void>;
  onStatus(callback: (state: AccountView) => void): () => void;
}
