import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AccountRoot } from './components/AccountRoot';
import './styles/theme.css';
import './styles/app.css';
import './styles/account.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><AccountRoot/></React.StrictMode>);
