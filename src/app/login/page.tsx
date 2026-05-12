'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleLogin = async () => {
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (e) setError(e.message);
    else router.push('/dashboard');
  };

  return (
    <div className="p-8 max-w-sm mx-auto pt-20">
      <h1 className="font-mincho text-2xl font-extrabold mb-2">本部ログイン</h1>
      <p className="text-xs text-muted font-mono mb-6 tracking-wider">HQ ADMIN</p>

      <div className="border-2 border-ink bg-paper p-6 shadow-ink">
        <label className="block text-xs font-bold mb-1.5 text-muted">メール</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full border-2 border-ink p-2 mb-3 bg-paper"
        />
        <label className="block text-xs font-bold mb-1.5 text-muted">パスワード</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border-2 border-ink p-2 mb-4 bg-paper"
        />
        <button
          onClick={handleLogin}
          disabled={busy}
          className="bg-ink text-paper p-3 w-full font-mincho font-bold disabled:opacity-50"
        >
          {busy ? '...' : 'ログイン'}
        </button>
        {error && <div className="mt-3 text-xs text-accent font-bold">⚠ {error}</div>}
      </div>
    </div>
  );
}
