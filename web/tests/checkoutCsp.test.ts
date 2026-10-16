import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import nextConfig from '../next.config.ts';

const baseline=[
  "default-src 'self'","script-src 'self' 'unsafe-inline'","style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:","font-src 'self'","connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "frame-ancestors 'none'","base-uri 'self'","form-action 'self'","object-src 'none'","upgrade-insecure-requests",
].join('; ');
const settings={CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',
  SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',
  SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg',SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',
  SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublicclient000000',
  SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:'00000000-0000-4000-8000-000000000001'};
beforeEach(()=>{for(const [key,value]of Object.entries(settings))vi.stubEnv(key,value);});
afterEach(()=>vi.unstubAllEnvs());
const headers=()=>nextConfig.headers!();
function directives(value:string){return new Map(value.split(';').map(part=>{const [name,...sources]=part.trim().split(/\s+/);return [name,sources];}));}

describe('narrow Sandbox checkout CSP',()=>{
  it('permits the actual Paddle.js Sandbox iframe host and API only on the exact checkout page',async()=>{
    // Public SDK static flow: sandbox checkoutFrontEndBase -> /paddlejs/v2 -> iframe.src.
    // No SDK initialization/open, provider request or payment is used by this regression.
    const rules=await headers(),checkout=rules.find(rule=>rule.source==='/account/checkout')!;
    expect(rules).toHaveLength(2);expect(checkout.headers).toHaveLength(1);
    const policy=checkout.headers.find(header=>header.key==='Content-Security-Policy')!.value;
    const sources=directives(policy);
    expect(sources.get('frame-src')).toEqual(['https://sandbox-buy.paddle.com']);
    expect(sources.get('connect-src')).toEqual(["'self'",'https://*.supabase.co','wss://*.supabase.co','https://sandbox-api.paddle.com']);
    expect(sources.get('script-src')).toEqual(["'self'","'unsafe-inline'",'https://cdn.paddle.com']);
    // Initialize appends exactly this Sandbox stylesheet to the parent head.
    // A path-bearing source avoids granting the entire Sandbox CDN for styles.
    expect(sources.get('style-src')).toEqual(["'self'","'unsafe-inline'",'https://sandbox-cdn.paddle.com/paddle/v2/assets/css/paddle.css']);
    expect(sources.get('img-src')).toEqual(["'self'",'data:']);
    expect(sources.get('font-src')).toEqual(["'self'"]);
    expect(policy).not.toMatch(/sandbox-checkout\.paddle\.com|sandbox-create-checkout\.paddle\.com|https:\/\/\*\.paddle\.com|https:\/\/(?:buy|api|create-checkout)\.paddle\.com|profitwell/);
    expect(sources.get('frame-src')).not.toContain('https://sandbox-buy.paddle.com.attacker.invalid');
    expect(sources.get('frame-ancestors')).toEqual(["'none'"]);
    expect(sources.get('form-action')).toEqual(["'self'"]);
    expect(sources.get('object-src')).toEqual(["'none'"]);
  });
  it('preserves the global Cluera staging policy and every existing protection header',async()=>{
    const rules=await headers(),global=rules[0];expect(global.source).toBe('/(.*)');
    expect(global.headers).toEqual([
      {key:'Content-Security-Policy',value:baseline},
      {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
      {key:'X-Content-Type-Options',value:'nosniff'},
      {key:'Cache-Control',value:'no-store'},
      {key:'X-Frame-Options',value:'DENY'},
      {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=(), payment=()'},
      {key:'Cross-Origin-Opener-Policy',value:'same-origin'},
    ]);
    expect(global.headers[0].value).not.toContain('paddle.com');
    expect(rules.slice(1).map(rule=>rule.source)).toEqual(['/account/checkout']);
  });
  it.each([
    ['SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED','true'],['SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED',''],
    ['SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS',''],['PADDLE_ENVIRONMENT','live'],
    ['SIGMAROUND_ACCOUNT_ORIGIN','https://sigmaround.vercel.app'],['NEXT_PUBLIC_SUPABASE_URL','https://wrong-project.supabase.co'],
    ['SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF','wrong-project'],['SIGMAROUND_ACCOUNTS_ENABLED','false'],
    ['SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','false'],['NEXT_PUBLIC_PADDLE_CLIENT_TOKEN','live_synthetic'],
  ])('adds no Paddle allowance when %s is %j',async(key,value)=>{
    vi.stubEnv(key,value);const rules=await headers();expect(rules).toHaveLength(1);
    expect(rules[0].source).toBe('/(.*)');expect(rules[0].headers[0]).toEqual({key:'Content-Security-Policy',value:baseline});
    expect(JSON.stringify(rules)).not.toContain('paddle.com');
  });
});
