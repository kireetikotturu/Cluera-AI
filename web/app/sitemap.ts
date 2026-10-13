import type {MetadataRoute} from 'next';
export default function sitemap():MetadataRoute.Sitemap{return ['','/pricing','/setup','/support','/download'].map(path=>({url:'https://cluera-ai-staging.vercel.app'+path,changeFrequency:'monthly',priority:path?.7:1}));}
