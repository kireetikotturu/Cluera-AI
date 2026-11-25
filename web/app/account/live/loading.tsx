import './live.css';
/** The live page opens with the same placeholder it shows while it loads its data. */
export default function Loading() {
  return <main aria-busy="true"><div className="lv-root"><div className="lv-app"><div className="lv-stack"><div className="lv-skeleton"/><div className="lv-skeleton" style={{height:70}}/><div className="lv-skeleton"/><div className="lv-skeleton"/></div></div></div></main>;
}
