import { handleNativeAccount } from '../../../../../lib/accounts/native';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<{ action: string }> }) {
  return handleNativeAccount(request, (await context.params).action);
}
export const POST = GET;
