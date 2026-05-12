'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        router.push('/login');
        return;
      }
      setEmail(data.session.user.email || null);
      setReady(true);
    });
  }, [router]);

  if (!ready) return <div className="p-8 font-mincho">確認中…</div>;

  return (
    <div>
      <header className="border-b-2 border-ink bg-paper px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-6">
          <Link href="/" className="font-mincho text-lg font-extrabold">日報システム</Link>
          <nav className="flex gap-1 text-sm font-bold">
            <Link href="/dashboard" className="px-3 py-1 border-2 border-ink hover:bg-paper2">ダッシュボード</Link>
            <Link href="/admin" className="px-3 py-1 border-2 border-ink hover:bg-paper2">マスタ管理</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-muted">{email}</span>
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              router.push('/login');
            }}
            className="text-xs border-2 border-ink px-3 py-1 font-bold hover:bg-paper2"
          >
            ログアウト
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
