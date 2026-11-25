import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {AiCostsView,compact,fillDays,periodStart,rupees,typicalCost,usedText} from '../app/account/admin/AiCosts';
import {shapeAiCostReport} from '../lib/accounts/aiCost';

const report=shapeAiCostReport({timeZone:'Asia/Kolkata',trackingSince:'2026-11-26T04:00:00Z',
 totals:{costUsd:1.2,answers:84,otherRequests:3,audioMs:9_810_000,unpriced:2,estimated:1,customers:2,sessions:7,sessionMs:5_580_000,sessionCostUsd:1.15,liveNow:1},
 models:[{provider:'deepgram',model:'flux-general-en',requests:12,audioMs:9_810_000,costUsd:1.0628},
  {provider:'gemini',model:'gemini-3.6-flash',requestedAs:['gemini-3.5-flash'],requests:72,answers:70,otherRequests:2,inputTokens:210_000,cachedTokens:40_000,outputTokens:31_000,costUsd:0.137,estimated:1},
  {provider:'openai',model:'gpt-9-new',requests:2,answers:2,inputTokens:10,outputTokens:10,costUsd:0,unpriced:2}],
 customers:[{userId:'u1',email:'live@example.invalid',costUsd:0.9,answers:50,audioMs:6_000_000,sessions:4,sessionMs:3_600_000,sessionCostUsd:0.9,running:true}],
 sessions:[{userId:'u1',email:'live@example.invalid',device:'web',startedAt:'2026-11-26T04:30:00Z',running:true,sessionMs:600_000,costUsd:0.1,answers:3,audioMs:900_000,models:['flux-general-en','gemini-3.6-flash']},
  {userId:'u2',email:'done@example.invalid',device:'windows',startedAt:'2026-11-25T14:00:00Z',endedAt:'2026-11-25T14:40:00Z',running:false,sessionMs:2_100_000,costUsd:0.3,answers:20,audioMs:3_900_000,models:['gemini-3.6-flash']}],
 days:[{day:'2026-11-25',costUsd:0.4,answers:30,audioMs:3_000_000},{day:'2026-11-26',costUsd:0.8,answers:54,audioMs:6_810_000}],
 providerDays:[{day:'2026-11-25',provider:'gemini',requests:30,inputTokens:90_000,outputTokens:12_000,costUsd:0.06}],
 prices:[{provider:'gemini',model:'gemini-4-argon',from:'2026-01-01',input:2,cached:0.1,output:10},{provider:'gemini',model:'gemini-4-argon',from:'2099-01-01',input:4,cached:0.2,output:20},
  {provider:'deepgram',model:'flux-general-en',from:'2026-01-01',audioMinute:0.0065,note:'Deepgram promotional price'}]},88);

it('leads with the total, the cost per hour, sessions live now and every model’s typical cost',()=>{
 const html=renderToStaticMarkup(createElement(AiCostsView,{report,period:'7d'}));
 for(const text of ['Total AI cost','₹106','includes 1 stopped reply estimated','Cost per hour of sessions','₹65.3','1h 33m','1 live now','2 customers','84 answers',
  '2 requests used a model with no price yet','asked as gemini-3.5-flash','70 answers · 210k tokens in (40k cached) · 31k out · 2 stopped or failed','per audio minute','per answer',
  'No price yet','Cost per day','Live now','● Running','Windows app','Phone','10 hours','From 1 Jan 2099','Deepgram promotional price','Check against each provider’s bill'])
  expect(html).toContain(text);
 expect(html).not.toContain('NaN');expect(html).not.toContain('undefined');
});
it('shows a calm empty page before anything is counted',()=>{
 const html=renderToStaticMarkup(createElement(AiCostsView,{report:shapeAiCostReport({},88),period:'today'}));
 for(const text of ['₹0','No AI requests in this period.','No sessions in this period.','Nothing counted yet'])expect(html).toContain(text);
 expect(html).not.toContain('Cost per day');expect(html).not.toContain('NaN');
});
it('works out periods in local time, quiet days and readable amounts',()=>{
 const now=new Date(2026,10,26,15,30);
 expect(periodStart('today',now)).toEqual(new Date(2026,10,26));expect(periodStart('7d',now)).toEqual(new Date(2026,10,20));
 expect(periodStart('30d',now)).toEqual(new Date(2026,9,28));expect(periodStart('all',now)).toBeNull();
 const days=fillDays([{day:'2026-11-24',costUsd:1,answers:1,audioMs:0}],new Date(2026,10,20),now);
 expect(days.map(day=>day.day)).toEqual(['2026-11-20','2026-11-21','2026-11-22','2026-11-23','2026-11-24','2026-11-25','2026-11-26']);
 expect(days[4].costUsd).toBe(1);expect(fillDays([],null,now)).toEqual([]);
 expect(fillDays([{day:'2025-01-01',costUsd:1,answers:1,audioMs:0}],null,now)).toHaveLength(62);
 expect([rupees(0),rupees(0.0123),rupees(2.5),rupees(45.67),rupees(123456.7)]).toEqual(['₹0','₹0.012','₹2.50','₹45.7','₹1,23,457']);
 expect([compact(950),compact(1_500),compact(40_400),compact(2_500_000)]).toEqual(['950','1.5k','40k','2.50M']);
 const row=report.models[1];expect(typicalCost(row,88)).toBe('₹0.17 per answer');expect(usedText(report.models[0])).toBe('164 min of audio · 12 streams');
});
