'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';

const CATEGORIES = ['豆類', '穀類', '漬物', 'みそ', 'お茶', 'その他'];

export function ProductsMaster() {
  const [rows, setRows] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRow, setNewRow] = useState({ name: '', category: '豆類' });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase.from('products').select('*').order('sort_order');
    setRows(data || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const addRow = async () => {
    if (!newRow.name) {
      alert('商品名は必須です');
      return;
    }
    const maxSort = Math.max(0, ...rows.map((r) => r.sort_order));
    const { error } = await supabase.from('products').insert({
      ...newRow,
      sort_order: maxSort + 1,
    });
    if (error) {
      alert(error.message);
      return;
    }
    setNewRow({ name: '', category: '豆類' });
    load();
  };

  const toggleActive = async (id: number, current: boolean) => {
    await supabase.from('products').update({ is_active: !current }).eq('id', id);
    load();
  };

  if (loading) return <div className="p-8 font-mincho">読み込み中…</div>;

  return (
    <div>
      <table className="w-full border-2 border-ink bg-paper text-sm">
        <thead className="bg-ink text-paper">
          <tr>
            <th className="p-2.5 text-left w-16">ID</th>
            <th className="p-2.5 text-left">商品名</th>
            <th className="p-2.5 text-left">カテゴリ</th>
            <th className="p-2.5 text-center">並び順</th>
            <th className="p-2.5 text-center">状態</th>
            <th className="p-2.5 text-center w-32">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-b border-ink ${!r.is_active ? 'text-stone-400' : ''}`}>
              <td className="p-2.5 font-mono">{r.id}</td>
              <td className="p-2.5">{r.name}</td>
              <td className="p-2.5">
                <span className="inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink bg-paper2">
                  {r.category}
                </span>
              </td>
              <td className="p-2.5 text-center font-mono">{r.sort_order}</td>
              <td className="p-2.5 text-center">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.is_active ? 'bg-paper2' : 'bg-stone-300'
                }`}>
                  {r.is_active ? '取扱中' : '停止'}
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
        <b className="font-mincho block mb-2.5">＋ 新商品を追加</b>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            placeholder="商品名"
            value={newRow.name}
            onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm min-w-[200px]"
          />
          <select
            value={newRow.category}
            onChange={(e) => setNewRow({ ...newRow, category: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm"
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
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
