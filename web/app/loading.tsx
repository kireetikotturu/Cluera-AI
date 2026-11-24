/** Shown instantly while the next page loads, so every click feels immediate. */
export default function Loading(){
 return <main className="page-loading" aria-busy="true" aria-label="Loading"><div className="page-loading-bar"/><div className="page-loading-card"/><div className="page-loading-row"><i/><i/><i/></div></main>;
}
