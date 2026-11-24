import type {Metadata} from 'next';
import {AccountDownload} from '../AccountWebsite';
export const metadata:Metadata={title:'Download Cluera AI for Windows',description:'Download Cluera AI for Windows 10 and 11.'};
export const dynamic='force-dynamic';
export default async function DownloadPage(){return AccountDownload();}
