import Link from 'next/link';
import {approvedAccountRelease} from '@/lib/accounts/releases';
import {AccountPricing} from './AccountPricing';
import {BrandMark} from './BrandMark';
import type {ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';

/** Account-only server pages. Separate Cluera pages; old product services remain outside this source. */
export function AccountHome({catalog=null}:{catalog?:ClueraPublicRevision[]|null}={}){
 return <main className="home">
  <section className="hero"><div className="hero-copy reveal">
   <p className="pill"><span className="pill-dot" aria-hidden="true"/>Your AI interview copilot for Windows</p>
   <h1>Walk into every interview <span className="accent-serif">ready.</span></h1>
   <p className="lede">Cluera listens to the conversation, transcribes it live and gives you clear, tailored answers in seconds, built from your résumé and the job description. One Cluera account, one shared time balance.</p>
   <div className="hero-actions"><Link className="button" href="/download">Download for Windows</Link><Link className="button secondary when-signed-out" href="/account">Sign in / create account</Link></div>
   <div className="trust-row"><span>15 free minutes to start</span><span>No API keys needed</span><span>Pay only for the time you use</span></div>
  </div>
  <div className="hero-visual reveal" style={{'--d':'.15s'} as React.CSSProperties} aria-hidden="true">
   <div className="app-window">
    <div className="app-bar"><i/><i/><i/><b>Cluera AI · Live session</b><span className="live-badge">Live</span></div>
    <div className="app-body">
     <div className="app-transcript">
      <p className="app-label">Interviewer</p>
      <p className="typing">Tell me about a project where you had to scale a system under pressure.</p>
      <div className="wave"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div>
     </div>
     <div className="app-answer">
      <p className="app-label">Suggested answer</p>
      <span className="line" style={{'--w':'92%'} as React.CSSProperties}/><span className="line" style={{'--w':'80%'} as React.CSSProperties}/><span className="line" style={{'--w':'86%'} as React.CSSProperties}/><span className="line" style={{'--w':'58%'} as React.CSSProperties}/>
      <div className="app-chips"><span>Résumé</span><span>Job description</span><span>STAR format</span></div>
     </div>
    </div>
   </div>
   <div className="float-card float-a"><b>2.4s</b><span>Answer ready</span></div>
   <div className="float-card float-b"><b>3h 15m</b><span>Time left</span></div>
  </div></section>
  <section id="features" className="section"><div className="section-heading reveal"><p className="kicker">Features</p><h2>Everything you need, <span className="accent-serif">nothing you don't.</span></h2><p>A calm, focused workspace that keeps up with the conversation so you can focus on the person in front of you.</p></div><div className="feature-grid">
   <Feature icon="mic" title="Live transcription" text="Both sides of the conversation are transcribed in real time, clearly separated."/>
   <Feature icon="spark" title="Instant AI answers" text="Get a clear, structured answer the moment a question lands, or let Auto Answer do it for you."/>
   <Feature icon="doc" title="Your context, built in" text="Add your résumé, the job description and notes. Every answer is tailored to you and the role."/>
   <Feature icon="lock" title="Private by design" text="Your session history stays on your computer. Saving transcripts is always your choice."/>
   <Feature icon="clock" title="One shared balance" text="Buy time once and use it on any of your devices. Packs never expire."/>
   <Feature icon="bolt" title="Ready in minutes" text="Sign in, add your context and start. No API keys, no setup headaches."/>
  </div></section>
  <section id="how" className="section split-section"><div className="reveal"><p className="kicker">How it works</p><h2>Up and running in <span className="accent-serif">three steps.</span></h2><p className="section-copy">Create your account, install the app and start your first session. Your first 15 minutes are free.</p><Link className="button secondary" href="/setup">Read the setup guide</Link></div><ol className="steps">
   <li className="reveal"><span>1</span><div><b>Create your account</b><p>Sign up with email or Google and verify your address. You get 15 free minutes.</p></div></li>
   <li className="reveal" style={{'--d':'.08s'} as React.CSSProperties}><span>2</span><div><b>Download Cluera for Windows</b><p>Install the app on Windows 10 or 11 and sign in with the same account.</p></div></li>
   <li className="reveal" style={{'--d':'.16s'} as React.CSSProperties}><span>3</span><div><b>Start a session</b><p>Add your résumé and the job description, check your audio and you're ready.</p></div></li>
  </ol></section>
  <AccountPricing catalog={catalog}/>
  <section className="section faq"><div className="section-heading reveal"><p className="kicker">FAQ</p><h2>Questions, <span className="accent-serif">answered.</span></h2></div><div className="faq-list">
   <Faq q="Is there a free trial?" a="Yes. Every new account gets 15 free minutes, once. No card needed."/>
   <Faq q="Do my hours expire?" a="One-time packs never expire, and packs stack. Your balance is shared across all your devices."/>
   <Faq q="How do I pay?" a="Securely through Razorpay with UPI, cards, netbanking or wallets. Your hours are added automatically, usually within 2 minutes."/>
   <Faq q="What if I close the payment window?" a="You are not charged. You can continue the same payment or cancel it and start again whenever you like."/>
   <Faq q="Which computers are supported?" a="Cluera runs on Windows 10 and 11 and needs an internet connection during sessions."/>
   <Faq q="Can I get a refund?" a="See our refund policy for details, or contact support and we will help."/>
  </div></section>
  <section className="final-cta reveal"><p className="kicker">Get started</p><h2>Your next interview starts <span className="accent-serif">here.</span></h2><p>Create your free account and try Cluera with 15 free minutes.</p><div className="hero-actions"><Link className="button when-signed-out" href="/account#signup">Create free account</Link><Link className="button when-signed-in" href="/download">Download for Windows</Link><Link className="button secondary" href="/pricing">See pricing</Link></div></section>
 </main>;
}
const icons:Record<string,React.ReactNode>={
 mic:<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a7 7 0 0 0 14 0M12 19v3"/>,
 spark:<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 12l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>,
 doc:<path d="M7 3h7l5 5v13H7V3Zm7 0v5h5M10 13h6M10 17h6"/>,
 lock:<path d="M6 11h12v10H6V11Zm3 0V8a3 3 0 0 1 6 0v3"/>,
 clock:<path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2"/>,
 bolt:<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>,
};
function Feature({icon,title,text}:{icon:string;title:string;text:string}){return <article className="feature reveal"><span className="feature-icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[icon]}</svg></span><h3>{title}</h3><p>{text}</p></article>;}
function Faq({q,a}:{q:string;a:string}){return <details className="faq-item reveal"><summary>{q}</summary><p>{a}</p></details>;}

type Release=Awaited<ReturnType<typeof approvedAccountRelease>>;
let lastRelease:{value:Release;at:number}|null=null;
/** The page may show a release up to 15 seconds old so it opens at once; the download button itself always uses the live record. */
async function pageRelease():Promise<Release>{
 if(process.env.NODE_ENV!=='test'&&lastRelease&&Date.now()-lastRelease.at<15_000)return lastRelease.value;
 const value=await approvedAccountRelease();lastRelease={value,at:Date.now()};return value;
}
export async function AccountDownload(){
 let release:Release=null,unavailable=false;
 try{release=await pageRelease();}catch{unavailable=true;}
 return <main className="content-page download-page"><div className="content-hero"><p className="kicker">Download</p><h1>Get Cluera for <span className="accent-serif">Windows.</span></h1><p>Install the app, sign in with your Cluera account and start your first session. Your first 15 minutes are free.</p></div>
  <article className="download-card"><div className="download-icon"><BrandMark size={56}/></div>
   {release?<><p className="kicker">Version {release.version}</p><h2>Latest version {release.version}</h2><p>{release.releaseNotes||'The latest Cluera AI app for Windows.'}</p>
    <div className="download-meta"><span>Windows 10 &amp; 11 (64-bit)</span><span>{Math.round(release.fileSizeBytes/1_000_000)} MB</span><span>Free to install</span></div>
    <a className="button" href="/account/download">Download for Windows</a>
    <p>The first time you open it, Windows may show “Windows protected your PC”. Click <b>More info</b> and then <b>Run anyway</b>.</p></>
    :<><h2>{unavailable?'Download temporarily unavailable':'Download coming soon'}</h2><p>{unavailable?'We could not load the download right now. Please try again in a few minutes.':'The Windows app will be available here shortly. Create your account now so you are ready.'}</p></>}
   <p><Link className="when-signed-out" href="/account">Sign in / create account</Link><Link className="when-signed-in" href="/account">My account</Link> · <Link href="/setup">Setup guide</Link></p>
  </article>
 </main>;
}

export function AccountSetup(){
 return <main className="content-page"><div className="content-hero"><p className="kicker">Setup guide</p><h1>From sign-up to your <span className="accent-serif">first session.</span></h1><p>You need Windows 10 or 11, a Cluera account and an internet connection. No API keys or extra setup.</p></div>
  <div className="guide-grid"><aside><b>On this page</b><a href="#install">Install</a><a href="#signin">Sign in</a><a href="#balance">Your time</a><a href="#session">Add your context</a><a href="#verify">Check audio</a></aside><div className="guide-copy">
   <Step id="install" n="01" title="Install Cluera"><p>Go to the <Link href="/download">download page</Link> and run the installer. If Windows shows “Windows protected your PC”, click <b>More info</b> and then <b>Run anyway</b>.</p></Step>
   <Step id="signin" n="02" title="Create your account and sign in"><p>Create an account and confirm your email on <Link href="/account">the account page</Link>, or continue with Google. Then open Cluera and sign in with the same account. Forgot your password? Reset it on the website.</p></Step>
   <Step id="balance" n="03" title="Check your time"><p>Every new account gets 15 free minutes. Buy more time on the <Link href="/pricing">pricing page</Link> whenever you need it. Your balance is shared across all your devices, and time is only used while a session is running.</p></Step>
   <Step id="session" n="04" title="Add your context"><p>Add the role, company, your résumé and the job description. You can upload PDF, DOCX, TXT and Markdown files. Your session history stays on your computer, and saving transcripts is always your choice.</p></Step>
   <Step id="verify" n="05" title="Check your audio and start"><p>Use Device Check to confirm Cluera can hear the interviewer (and your microphone, if you want). Then start your session, ask for answers when you need them or turn on Auto Answer, and end the session when you are done.</p></Step>
  </div></div>
 </main>;
}
function Step({id,n,title,children}:{id:string;n:string;title:string;children:React.ReactNode}){return <section id={id} className="guide-step"><span>{n}</span><div><h2>{title}</h2>{children}</div></section>;}
