import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {UsageOverviewPanel,UsageDetailPanel,money,usageLine} from '../app/account/admin/CustomerUsage';
const group=(usd:number)=>({rows:[{provider:'gemini',model:'gemini-3.5-flash',calls:4,inputTokens:12000,outputTokens:3000,thinkingTokens:500,audioMs:0,costUsd:usd,costInr:usd*88}],totalUsd:usd,totalInr:usd*88});
const assumptions={usdToInr:88};
it('shows who is live, blocked, how long they used it and the estimated cost, with the assumptions visible',()=>{
 const html=renderToStaticMarkup(createElement(UsageOverviewPanel,{report:{overall:{customerCount:2,activeNow:1,usedMs:5_400_000,usage:group(0.5)},assumptions,customers:[
  {userId:'a',email:'live@example.invalid',state:'ACTIVE',usedMs:3_600_000,activeNow:true,lastActiveAt:null,usage:group(0.25)},
  {userId:'b',email:'banned@example.invalid',state:'SUSPENDED',usedMs:1_800_000,activeNow:false,lastActiveAt:null,usage:group(0.25)}]},
  error:'',loading:false,updatedAt:'5:00:00 PM',onRefresh:()=>{},onSelect:()=>{},selected:'',disabled:false}));
 expect(html).toContain('Live now');expect(html).toContain('Blocked');expect(html).toContain('1h 0m');expect(html).toContain('30m');
 expect(html).toContain('How the cost is estimated');expect(html).toContain('updates every 15 seconds');
});
it('shows a customer’s models, sessions and the time an admin removed without counting it as their use',()=>{
 const html=renderToStaticMarkup(createElement(UsageDetailPanel,{detail:{customer:{userId:'a',email:'a@example.invalid',state:'ACTIVE',usedMs:1_200_000,activeNow:false,activeSince:null,sessionCount:3,lastActiveAt:null},
  adminReducedMs:600_000,models:group(0.1),models30d:group(0.1),sessions:[{runId:'r1',startedAt:null,state:'CLOSED',usedMs:600_000,usage:group(0.05)}],assumptions}}));
 expect(html).toContain('Total session time used');expect(html).toContain('gemini-3.5-flash');expect(html).toContain('Time you removed by hand: 10m');
 expect(renderToStaticMarkup(createElement(UsageDetailPanel,{detail:null}))).toContain('Loading');
});
it('formats money in rupees with the dollar figure and describes token and speech use',()=>{
 expect(money({totalInr:0.5,totalUsd:0.0057})).toBe('₹0.50 ($0.0057)');
 expect(money({totalInr:1234.4,totalUsd:14.03})).toBe('₹1,234 ($14.03)');
 expect(usageLine({...group(1).rows[0],provider:'deepgram',audioMs:180_000})).toBe('3m of audio');
 expect(usageLine(group(1).rows[0])).toBe('12.0k in · 3.5k out');
});
