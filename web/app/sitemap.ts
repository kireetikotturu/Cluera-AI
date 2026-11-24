import type {MetadataRoute} from 'next';
export default function sitemap():MetadataRoute.Sitemap{return ['','/pricing','/setup','/support','/download','/terms','/privacy','/refunds'].map(path=>({url:'https://www.clueraai.in'+path,changeFrequency:'monthly',priority:path?.7:1}));}
