'use client';

import { createClient } from '@supabase/supabase-js';
import { getBrowserEnv } from '../env';

let singleton: ReturnType<typeof createClient> | undefined;
export function getBrowserSupabase() {
  if (!singleton) {
    const env = getBrowserEnv();
    singleton = createClient(env.url, env.key);
  }
  return singleton;
}
