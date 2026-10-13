/** Owner-confirmed Cluera presentation policy v2. NOT a financial catalog.
 * New IDs deliberately cannot alias historical SigmaRound/Paddle offer codes.
 * Provider plans, shared-ledger processing ownership and a separate billing
 * schema review/approval are still required before any purchase is enabled.
 */
export const CLUERA_TARGET_POLICY = 'cluera-target-v2' as const;
export const clueraTargetPlans = Object.freeze([
  Object.freeze({id:'cluera-v2-pack-3h',name:'Cluera 3 Hours',amount:'54900',seconds:10800,interval:null}),
  Object.freeze({id:'cluera-v2-pro-40h-month',name:'Cluera Pro 40 Hours',amount:'549900',seconds:144000,interval:'month'}),
  Object.freeze({id:'cluera-v2-pro-100h-month',name:'Cluera Pro 100 Hours',amount:'959900',seconds:360000,interval:'month'}),
  Object.freeze({id:'cluera-v2-enterprise-200h-month',name:'Cluera Enterprise 200 Hours',amount:'1954900',seconds:720000,interval:'month'}),
] as const);
