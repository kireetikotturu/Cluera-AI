import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({access:vi.fn(),headers:vi.fn(),protected:vi.fn()}));
vi.mock('next/headers',()=>({headers:mocks.headers}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NEXT_NOT_FOUND');}}));
vi.mock('../lib/accounts/adminAccess',()=>({accountAdminAccessRequest:mocks.access}));
vi.mock('../app/account/admin/AccountAdmin',()=>({AccountAdmin:()=>{mocks.protected();return createElement('div',null,'PRIVATE_ADMIN_CONTROLS');}}));
vi.mock('../app/account/AdminRoleNavigation',()=>({AdminAccessGate:()=>createElement('section',null,'VERIFY_ACCESS_ONLY'),AdminProtectedContent:({children}:{children:ReactNode})=>createElement('div',null,children)}));
import Page from '../app/account/admin/page';
beforeEach(()=>{vi.resetAllMocks();mocks.headers.mockResolvedValue(new Headers({cookie:'sealed-synthetic-cookie'}));});
it.each([401,503])('direct %s page exposes only neutral access gate',async status=>{
 mocks.access.mockResolvedValue(new Response(null,{status}));const html=renderToStaticMarkup(await Page());
 expect(html).toContain('VERIFY_ACCESS_ONLY');expect(html).not.toMatch(/PRIVATE_ADMIN_CONTROLS|ACCOUNT CONTROL CENTER|Account administration|Customers, policies/);
 expect(mocks.protected).not.toHaveBeenCalled();expect(mocks.access).toHaveBeenCalledOnce();
 const [request,refresh]=mocks.access.mock.calls[0];expect(refresh).toBe(false);expect(request.headers.get('cookie')).toBe('sealed-synthetic-cookie');
});
it('role/recovery denial stops rendering before protected children',async()=>{
 mocks.access.mockResolvedValue(new Response(null,{status:403}));await expect(Page()).rejects.toThrow('NEXT_NOT_FOUND');expect(mocks.protected).not.toHaveBeenCalled();
});
it('server-verified role permits only the independently MFA-guarded workspace',async()=>{
 mocks.access.mockResolvedValue(new Response(null,{status:200}));expect(renderToStaticMarkup(await Page())).toContain('PRIVATE_ADMIN_CONTROLS');expect(mocks.protected).toHaveBeenCalledOnce();
});
