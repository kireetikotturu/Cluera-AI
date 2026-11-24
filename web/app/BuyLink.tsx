'use client';
import Link from 'next/link';
import type {ReactNode} from 'react';
import {useSignedIn} from './account/AdminRoleNavigation';

/** One plan button. Signed-in visitors go straight to checkout; visitors known to be signed out go
 * straight to sign-in and return to the same plan afterwards. Nothing is charged by this link. */
export function BuyLink({offerCode,className,label,children}:{offerCode:string;className?:string;label:string;children:ReactNode}){
 const signedIn=useSignedIn(),query=`offer=${encodeURIComponent(offerCode)}`;
 const href=signedIn===false?`/account?${query}#login`:`/account/checkout?${query}`;
 return <Link className={className} href={href} aria-label={label}>{children}</Link>;
}
