/** Cluera logo: a soft "C" orbit with a spark, drawn inline so it stays crisp at any size. */
export function BrandMark({size=34}:{size?:number}){
 return <svg className="brand-mark" width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
  <defs>
   <linearGradient id="cluera-mark-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8f7dff"/><stop offset=".55" stopColor="#6b5cf6"/><stop offset="1" stopColor="#2fc6d4"/></linearGradient>
   <linearGradient id="cluera-mark-c" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff"/><stop offset="1" stopColor="#dcd6ff"/></linearGradient>
  </defs>
  <rect width="48" height="48" rx="14" fill="url(#cluera-mark-bg)"/>
  <rect x=".75" y=".75" width="46.5" height="46.5" rx="13.25" fill="none" stroke="#ffffff" strokeOpacity=".22" strokeWidth="1.5"/>
  <path d="M33.6 16.4a12 12 0 1 0 0 15.2" fill="none" stroke="url(#cluera-mark-c)" strokeWidth="5" strokeLinecap="round"/>
  <circle cx="34.5" cy="24" r="3.2" fill="#ffffff"/>
 </svg>;
}
export function Wordmark(){
 return <><BrandMark/><strong>Cluera <em>AI</em></strong></>;
}
