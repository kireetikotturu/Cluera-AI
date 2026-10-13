import type {AppConfig} from '../config/appConfig';
import type {ProviderName} from '../../shared/types';
import type {ModelCatalog} from './ModelCatalog';
import {MANAGED_DEEPGRAM_MODEL} from '../../shared/managedProviders';
/** No BYOK or default credential path in the Cluera application. */
export function assertProviderSetup(config:AppConfig,_provider:ProviderName):void {
 if(config.providerMutationInProgress)throw new Error('Provider settings are changing. Wait briefly before starting.');
 if(!config.accountManaged){
  if(!config.isProduction&&config.demoMode)return; // Isolated synthetic pipeline, never packaged.
  throw new Error('Cluera account authorization is unavailable.');
 }
 if(!config.gemini.managed)throw new Error('Cluera provider transport is unavailable.');
}
export function assertSessionProviderSetup(config:AppConfig,models:Pick<ModelCatalog,'isAllowed'>,geminiModel=config.gemini.model):void {
 assertProviderSetup(config,'gemini');assertProviderSetup(config,'deepgram');
 if(!models.isAllowed('gemini',geminiModel)||!models.isAllowed('deepgram',config.accountManaged?MANAGED_DEEPGRAM_MODEL:config.deepgram.model))throw new Error('The selected account model or transcription service is unavailable.');
}
