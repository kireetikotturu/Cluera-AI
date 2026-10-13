import type {Metadata} from 'next';
import {AccountDownload} from '../AccountWebsite';
export const metadata:Metadata={title:'Download Cluera AI for Windows',description:'Approved Cluera AI Windows TEST installer.'};
export const dynamic='force-dynamic';
export default async function DownloadPage(){return AccountDownload();}
