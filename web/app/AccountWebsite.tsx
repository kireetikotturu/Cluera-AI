import Link from 'next/link';
import {approvedAccountRelease} from '@/lib/accounts/releases';
import {AccountPricing} from './AccountPricing';
import type {ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';

/** Account-only server pages. Separate Cluera pages; old product services remain outside this source. */
export function AccountHome({catalog=null}:{catalog?:ClueraPublicRevision[]|null}={}){
 return <main>
  <section className="hero"><div className="hero-copy"><p className="kicker">Cluera AI · Windows TEST</p><h1>Your interview workspace.<br/><span>One Cluera account.</span></h1>
   <p className="lede">Sign in for managed AI answers and live transcription. Your active sessions share one server-managed time balance; no personal provider credentials are needed.</p>
   <div className="hero-actions"><Link className="button" href="/download">Download Cluera AI</Link><Link className="button secondary" href="/account">Sign in / create account</Link></div>
   <div className="trust-row"><span>One-time 15-minute trial</span><span>Managed AI and audio</span><span>Separate TEST installation</span></div>
  </div></section>
  <section id="features" className="section"><div className="section-heading"><p className="kicker">Your Windows workspace</p><h2>Context, audio and answers together.</h2><p>Cluera AI preserves the desktop workspace while authorizing AI usage through your shared account balance.</p></div><div className="feature-grid">
   <Feature title="Live conversation" text="Independent interviewer and microphone transcription, manual answers and opt-in Auto Answer."/>
   <Feature title="Your selected context" text="Use résumé, job description and supporting documents with bounded selected context for text and screenshot answers."/>
   <Feature title="Local history" text="Account-isolated session history, teleprompter, themes and shortcuts. Transcript saving is opt-in."/>
  </div></section>
  <section id="how" className="section split-section"><div><p className="kicker">How it works</p><h2>Verify your email.<br/>Sign in on Windows.</h2><p className="section-copy">Managed provider credentials stay on Cluera servers. Internet access and remaining account time are required for AI activity.</p></div><ol className="steps">
   <li><span>1</span><div><b>Create or sign in to your account</b><p>Use verified email/password or Google. Verification and password recovery are available on the account website.</p></div></li>
   <li><span>2</span><div><b>Install the approved Cluera TEST build</b><p>The download appears only after separate Cluera release approval. Keep your existing edition installed separately.</p></div></li>
   <li><span>3</span><div><b>Prepare and start a session</b><p>Select your model and context, check audio, and monitor your shared time balance.</p></div></li>
  </ol></section>
  <AccountPricing catalog={catalog}/>
  <section className="final-cta"><p className="kicker">Staging only</p><h2>A separate Cluera TEST build.</h2><p>Unsigned test software; Windows, AI, payment and update acceptance is still in progress. Not commercially approved.</p><Link className="button" href="/download">View Cluera download</Link></section>
 </main>;
}
function Feature({title,text}:{title:string;text:string}){return <article className="feature"><h3>{title}</h3><p>{text}</p></article>;}

export async function AccountDownload(){
 let release:Awaited<ReturnType<typeof approvedAccountRelease>>=null,unavailable=false;
 try{release=await approvedAccountRelease();}catch{unavailable=true;}
 return <main className="content-page download-page"><div className="content-hero"><p className="kicker">Cluera AI · Windows x64</p><h1>Download Cluera AI.</h1><p>Sign in with your verified Cluera account. AI and transcription are company-managed; your active sessions use your shared remaining time.</p></div>
  <article className="download-card"><div className="download-icon">Σ</div>
   {release?<><p className="kicker">Approved Cluera TEST release</p><h2>Latest version {release.version}</h2><p>{release.releaseNotes||'Separate Cluera AI Windows test build.'}</p>
    <div className="download-meta"><span>Windows x64</span><span>{Math.round(release.fileSizeBytes/1_000_000)} MB</span><span>Cluera AI only</span></div>
    <a className="button" href="/account/download">Download Cluera TEST installer</a></>
    :<><h2>{unavailable?'Cluera download temporarily unavailable':'Cluera TEST installer awaiting approval'}</h2><p>{unavailable?'The approval service is unavailable. No alternate installer is offered.':'The separately hosted Cluera TEST installer has not been approved for distribution. A GitHub pre-release alone does not enable this download.'}</p></>}
   <p>This is an unsigned TEST build, not a signed commercial release. Windows may show an Unknown Publisher warning. Use only for controlled testing.</p>
   <p>Cluera AI installs separately from the existing License Edition and does not upgrade it.</p>
   <p><Link href="/account">Sign in / create account</Link> · <Link href="/setup">Cluera setup guide</Link></p>
  </article>
 </main>;
}

export function AccountSetup(){
 return <main className="content-page"><div className="content-hero"><p className="kicker">Cluera AI setup</p><h1>From account to first Windows session.</h1><p>You need Windows 10/11, a verified Cluera account, internet access and available account time. Managed AI requires no personal provider credentials.</p></div>
  <div className="guide-grid"><aside><b>On this page</b><a href="#install">Install</a><a href="#signin">Sign in</a><a href="#balance">Account balance</a><a href="#session">Prepare context</a><a href="#verify">Check audio</a></aside><div className="guide-copy">
   <Step id="install" n="01" title="Install the approved Cluera TEST build"><p>Use <Link href="/download">Cluera download</Link> for the approved <code>ClueraAITestSetup-&lt;version&gt;.exe</code>. When approval is pending, no installer download is offered. This unsigned TEST product installs separately; do not remove or replace your existing edition.</p></Step>
   <Step id="signin" n="02" title="Verify your account and sign in"><p>Create an account and confirm your email on <Link href="/account">the account website</Link>, or use Google. Open Cluera AI and sign in. Use the website for forgotten-password recovery. Desktop session material is protected by Windows secure storage.</p></Step>
   <Step id="balance" n="03" title="Check remaining time"><p>Your one-time trial and eligible paid or audited staging-test allowance are server-managed. Concurrent sessions share the same balance. Dashboard browsing does not spend time; active AI and transcription do. Managed provider credentials stay on the server.</p></Step>
   <Step id="session" n="04" title="Prepare a session"><p>Add the role, company, résumé, job description and supporting context. Supported documents include PDF, DOCX, TXT and Markdown. Explicitly select cloud context when needed and choose an approved model. History stays local and account-isolated; saving transcripts is opt-in.</p></Step>
   <Step id="verify" n="05" title="Check audio and start"><p>Confirm interviewer audio and optional microphone transcription in Device Check. Transcription checks consume account time. Start when ready, try manual answers or opt-in Auto Answer, and end the session to stop provider work and settle usage.</p></Step>
  </div></div>
 </main>;
}
function Step({id,n,title,children}:{id:string;n:string;title:string;children:React.ReactNode}){return <section id={id} className="guide-step"><span>{n}</span><div><h2>{title}</h2>{children}</div></section>;}
