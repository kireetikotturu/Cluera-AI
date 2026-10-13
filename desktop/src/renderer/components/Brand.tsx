import clueraLogo from '../assets/cluera-ai.svg';

export function Brand(): JSX.Element {
  return <div className="brand">
    <span className="brand-mark"><img src={clueraLogo} alt="" /></span>
    <span className="brand-name">Cluera <strong>AI</strong></span>
  </div>;
}
