import { accountConfig } from '../../../../lib/accounts/config';
import { readAuthOptions } from '../../../../lib/accounts/authOptions';
import { json } from '../../../../lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  if (new URL(request.url).search) return json({ error: 'Invalid request.' }, 400);
  try { return json(await readAuthOptions(accountConfig())); }
  catch { return json({ google: 'unavailable' }); }
}
