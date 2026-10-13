import {createHash,generateKeyPairSync} from 'node:crypto';
// Synthetic keys only. Tests never read the real private signing file.
export const syntheticUpdatePair=generateKeyPairSync('ed25519');
export const syntheticUpdateKeySha256=createHash('sha256').update(syntheticUpdatePair.publicKey.export({type:'spki',format:'der'})).digest('hex');
