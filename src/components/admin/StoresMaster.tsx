'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Store } from '@/lib/types';

export function StoresMaster() {
  const [rows, setRows] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRow, setNewRow] = useState({ name: '', slug: '', open_time: '09:00', close_time: '18:00' });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('stores').select('*').order('id');
    setRows(data || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const addRow = async () => {
    if (!newRow.name || !newRow.slug) {
      alert('店舗名とSlugは必須です');
      return;
    }
    const { error } = await supabase.from('stores').insert(newRow);
    if (error) {
      alert(error.message);
      return;
    }
    setNewRow({ name: '', slug: '', open_time: '09:00', close_time: '18:00' });
    load();
  };

  const toggleActive = async (id: number, current: boolean) => {
    await supabase.from('stores').update({ is_active: !current }).eq('id', id);
    load();
  };

  if (loading) return <div className="p-8 font-mincho">読み込み中…</div>;

  return (
    <div>
      <table className="w-full border-2 border-ink bg-paper text-sm">
        <thead className="bg-ink text-paper">
          <tr>
            <th className="p-2.5 text-left w-16">ID</th>
            <th className="p-2.5 text-left">店舗名</th>
            <th className="p-2.5 text-left">URL Slug</th>
            <th className="p-2.5 text-left">営業時間</th>
            <th className="p-2.5 text-center">状態</th>
            <th className="p-2.5 text-center w-32">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-b border-ink ${!r.is_active ? 'text-stone-400' : ''}`}>
              <td className="p-2.5 font-mono">{r.id}</td>
              <td className="p-2.5">{r.name}</td>
              <td className="p-2.5 font-mono text-xs">/store/{r.slug}</td>
              <td className="p-2.5 font-mono text-xs">{r.open_time.slice(0,5)} - {r.close_time.slice(0,5)}</td>
              <td className="p-2.5 text-center">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.is_active ? 'bg-ink text-paper' : 'bg-stone-300'
                }`}>
                  {r.is_active ? '稼働中' : '停止'}
                </span>
              </td>
              <td className="p-2.5 text-center">
                <button
                  onClick={() => toggleActive(r.id, r.is_active)}
                  className={`text-xs px-2.5 py-1 border-1.5 border-ink font-bold ${
                    r.is_active ? 'text-accent border-accent' : ''
                  }`}
                >
                  {r.is_active ? '停止' : '復帰'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4 p-4 bg-paper2 border-2 border-dashed border-ink">
        <b className="font-mincho block mb-2.5">＋ 新規店舗を追加</b>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            placeholder="店舗名"
            value={newRow.name}
            onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm min-w-[140px]"
          />
          <input
            placeholder="slug(英数)"
            value={newRow.slug}
            onChange={(e) => setNewRow({ ...newRow, slug: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm font-mono min-w-[140px]"
          />
          <input
            value={newRow.open_time}
            onChange={(e) => setNewRow({ ...newRow, open_time: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm font-mono w-24"
          />
          <span>─</span>
          <input
            value={newRow.close_time}
            onChange={(e) => setNewRow({ ...newRow, close_time: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm font-mono w-24"
          />
          <button
            onClick={addRow}
            className="px-4 py-2 bg-ink text-paper border-2 border-ink font-mincho font-bold text-sm"
          >
            追加
          </button>
        </div>
      </div>
    </div>
  );
}
