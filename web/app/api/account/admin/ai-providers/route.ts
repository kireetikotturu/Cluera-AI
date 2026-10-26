import {providerAdminRequest} from '../../../../../lib/aiProviders/admin';
export const runtime='nodejs';
export const dynamic='force-dynamic';
// Quick setup runs several audited steps plus one provider metadata request.
export const maxDuration=60;
export const GET=providerAdminRequest;
export const POST=providerAdminRequest;
