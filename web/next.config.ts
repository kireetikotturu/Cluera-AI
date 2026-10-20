import type { NextConfig } from 'next';
import path from 'node:path';
import {assertPublishableKey} from './lib/supabase/publicKey';
// Reject secret-role values before Next can compile a NEXT_PUBLIC variable.
if(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!==undefined)assertPublishableKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
import { sandboxCheckoutEnabled } from './lib/billing/checkout/gate';
import { razorpayCheckoutEnabled } from './lib/payments/core/config';
import { billingUiCapabilities } from './lib/payments/cluera/billingUi';

const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join('; ');

const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(process.cwd(),'..') },
  outputFileTracingRoot: path.resolve(process.cwd(),'..'),
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    const billing=billingUiCapabilities();
    return [{
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: csp },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Cache-Control', value: 'no-store' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ],
    },...(sandboxCheckoutEnabled()?[{
      source:'/account/checkout',headers:[{key:'Content-Security-Policy',value:csp
        .replace("script-src 'self' 'unsafe-inline'","script-src 'self' 'unsafe-inline' https://cdn.paddle.com")
        // Initialize appends this fixed Sandbox stylesheet, not arbitrary CDN CSS.
        .replace("style-src 'self' 'unsafe-inline'","style-src 'self' 'unsafe-inline' https://sandbox-cdn.paddle.com/paddle/v2/assets/css/paddle.css")
        .replace("connect-src 'self' https://*.supabase.co wss://*.supabase.co","connect-src 'self' https://*.supabase.co wss://*.supabase.co https://sandbox-api.paddle.com")
        // Paddle.js Sandbox checkoutFrontEndBase builds this iframe source.
        // No wildcard, Live host or unrelated analytics capability is allowed.
        +'; frame-src https://sandbox-buy.paddle.com'}],
    }]:[]),...((razorpayCheckoutEnabled()||billing.mode==='live'&&billing.enabled)?['/account/checkout',...(process.env.CLUERA_BILLING_V2_ENABLED==='true'?['/pricing']:[])].map(source=>({
      source,headers:[{key:'Content-Security-Policy',value:csp
        .replace("script-src 'self' 'unsafe-inline'","script-src 'self' 'unsafe-inline' https://checkout.razorpay.com")
        .replace("connect-src 'self' https://*.supabase.co wss://*.supabase.co","connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.razorpay.com https://checkout.razorpay.com")
        +'; frame-src https://api.razorpay.com https://checkout.razorpay.com'}],
    })):[])];
  },
};

export default nextConfig;
