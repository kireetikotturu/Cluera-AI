import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_DISTRIBUTION } from '../../shared/accountDistribution';

/** Only the account package manifest + ASAR-contained trust file enable packaged accounts. */
export function packagedAccountDistribution(appPath: string, packaged: boolean): boolean {
  if (!packaged) return false;
  const metadata = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (metadata.name !== ACCOUNT_DISTRIBUTION.packageName && metadata.clueraProduct === undefined) return false;
  if (metadata.name !== ACCOUNT_DISTRIBUTION.packageName || metadata.clueraProduct !== ACCOUNT_DISTRIBUTION.product) {
    throw new Error('Invalid account product identity.');
  }
  const trust = JSON.parse(fs.readFileSync(path.join(appPath, 'resources', 'account-distribution.json'), 'utf8')) as Record<string, unknown>;
  for (const [key, value] of Object.entries(ACCOUNT_DISTRIBUTION)) {
    if (trust[key] !== value) throw new Error('Invalid account distribution trust.');
  }
  return true;
}
