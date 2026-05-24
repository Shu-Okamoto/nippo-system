'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    if (typeof window === 'undefined') {
      return {} as SupabaseClient;
    }
    throw new Error('Supabase環境変数が設定されていません(.env.local)');
  }
  _client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
    db: { schema: 'nippo' },
  });
  return _client;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop) {
    const c = getClient();
    return (c as any)[prop];
  },
});
