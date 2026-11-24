import {expect,it} from 'vitest';
import {costRow,costRows,tokenRate,usdToInr,shapeUsageReport} from '../lib/accounts/usageCost';
const gemini={provider:'gemini',model:'gemini-3.5-flash',calls:1,inputTokens:2_000_000,outputTokens:500_000,thinkingTokens:500_000,audioMs:0};
it('prices Gemini by input and output tokens, with thinking billed as output',()=>{
 const row=costRow(gemini,88);
 expect(row.costUsd).toBeCloseTo(2*0.30+1*2.50,6);
 expect(row.costInr).toBeCloseTo((2*0.30+1*2.50)*88,4);
});
it('prices Deepgram by minutes of audio and ignores tokens',()=>{
 const row=costRow({provider:'deepgram',model:'flux-general-en',calls:3,inputTokens:99,outputTokens:99,thinkingTokens:0,audioMs:600_000},90);
 expect(row.costUsd).toBeCloseTo(10*0.0077,6);
});
it('chooses a rate by provider and model family and totals rows',()=>{
 expect(tokenRate('gemini','gemini-3.5-pro').outputPerMillion).toBe(10);
 expect(tokenRate('gemini','gemini-3.5-flash-lite').inputPerMillion).toBe(0.10);
 expect(tokenRate('anthropic','claude').inputPerMillion).toBe(3);
 expect(costRows([gemini,gemini],88).totalUsd).toBeCloseTo(2*(2*0.30+1*2.50),6);
 expect(costRows([],88)).toEqual({rows:[],totalUsd:0,totalInr:0});
});
it('uses a safe exchange rate and never lets bad numbers through',()=>{
 expect(usdToInr({CLUERA_USD_INR:'91.5'})).toBe(91.5);
 for(const bad of ['0','abc','-5','100000',undefined])expect(usdToInr({CLUERA_USD_INR:bad})).toBe(88);
 const shaped=shapeUsageReport({code:'ACTIVE',customer:{userId:'u',email:'a@example.invalid',state:'ACTIVE',usedMs:'-5',activeNow:'yes'},models:[{provider:'gemini',model:'m',calls:'x',inputTokens:-1,outputTokens:null}],sessions:'bad'},88) as any;
 expect(shaped.customer.usedMs).toBe(0);expect(shaped.customer.activeNow).toBe(false);
 expect(shaped.models.rows[0]).toMatchObject({calls:0,inputTokens:0,outputTokens:0,costUsd:0});
 expect(shaped.sessions).toEqual([]);
});
