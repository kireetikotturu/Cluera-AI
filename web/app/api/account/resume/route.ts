import { resumeRequest } from '../../../../lib/accounts/resumeUpload';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Redrawing a large, picture-heavy PDF can take a few seconds.
export const maxDuration = 60;
export const POST = resumeRequest;
