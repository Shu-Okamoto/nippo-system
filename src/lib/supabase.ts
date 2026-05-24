'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// nippo スキーマを使うため、SupabaseClient のスキーマ型ジェネリクスを緩める
type NippoClient = SupabaseClient<any, any, any, any, any>;

let _client: NippoClient | null = null;

function getClient(): NippoClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    if (typeof window === 'undefined') {
      return {} as NippoClient;
    }
    throw new Error('Supabase環境変数が設定されていません(.env.local)');
  }
  _client = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
    db: { schema: 'nippo' },
  });
  return _client;
}

export const supabase: NippoClient = new Proxy({} as NippoClient, {
  get(_, prop) {
    const c = getClient();
    return (c as any)[prop];
  },
});
