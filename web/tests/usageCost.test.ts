import {expect,it} from 'vitest';
import {costRows,usdToInr,shapeUsageReport} from '../lib/accounts/usageCost';
import {aiCostRange,shapeAiCostReport} from '../lib/accounts/aiCost';
const gemini={provider:'gemini',model:'gemini-3.6-flash',calls:1,inputTokens:2_000_000,outputTokens:500_000,thinkingTokens:500_000,audioMs:0,costUsd:5.25,unpriced:0};
it('converts the database cost to rupees, totals it and keeps count of requests with no price',()=>{
 const group=costRows([gemini,{...gemini,costUsd:0,unpriced:2}],90);
 expect(group.rows[0].costInr).toBeCloseTo(5.25*90,6);expect(group.totalUsd).toBeCloseTo(5.25,6);expect(group.totalInr).toBeCloseTo(472.5,4);expect(group.unpriced).toBe(2);
 expect(costRows([],88)).toEqual({rows:[],unpriced:0,totalUsd:0,totalInr:0});
});
it('uses a safe exchange rate and never lets bad numbers through',()=>{
 expect(usdToInr({CLUERA_USD_INR:'91.5'})).toBe(91.5);
 for(const bad of ['0','abc','-5','100000',undefined])expect(usdToInr({CLUERA_USD_INR:bad})).toBe(88);
 const shaped=shapeUsageReport({code:'ACTIVE',customer:{userId:'u',email:'a@example.invalid',state:'ACTIVE',usedMs:'-5',activeNow:'yes'},models:[{provider:'gemini',model:'m',calls:'x',inputTokens:-1,outputTokens:null,costUsd:'free'}],sessions:'bad'},88) as any;
 expect(shaped.customer.usedMs).toBe(0);expect(shaped.customer.activeNow).toBe(false);
 expect(shaped.models.rows[0]).toMatchObject({calls:0,inputTokens:0,outputTokens:0,costUsd:0,costInr:0});
 expect(shaped.sessions).toEqual([]);
});
it('accepts only a proper period and time zone for the AI costs page',()=>{
 expect(aiCostRange.safeParse({from:'2026-11-26T00:00:00.000+05:30',to:null,tz:'Asia/Kolkata'}).success).toBe(true);
 expect(aiCostRange.safeParse({from:null,to:null,tz:null}).success).toBe(true);
 for(const bad of [{from:'today',to:null,tz:null},{from:null,to:null,tz:'x'.repeat(65)},{from:null,to:null,tz:"Asia/Kolkata'; drop"}])expect(aiCostRange.safeParse(bad).success).toBe(false);
});
it('makes an unexpected AI cost report harmless for the page',()=>{
 const report=shapeAiCostReport({totals:{costUsd:'x',sessions:-1},models:[{provider:'gemini',requestedAs:'no'}],sessions:[{startedAt:'bad',device:'tablet',models:[1,'gemini-3.6-flash']}],prices:[{input:null,audioMinute:0.0065}]},88);
 expect(report.totals).toMatchObject({costUsd:0,sessions:0});expect(report.models[0]).toMatchObject({requestedAs:[],costUsd:0});
 expect(report.sessions[0]).toMatchObject({startedAt:'',device:'windows',endedAt:null,models:['gemini-3.6-flash']});
 expect(report.prices[0]).toMatchObject({input:null,audioMinute:0.0065});
 expect(shapeAiCostReport({},88)).toMatchObject({models:[],customers:[],sessions:[],days:[],providerDays:[],prices:[],trackingSince:null,usdToInr:88,timeZone:'UTC'});
});
