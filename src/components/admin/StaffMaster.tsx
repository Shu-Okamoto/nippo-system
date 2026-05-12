'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Staff, Store, StaffRole } from '@/lib/types';

const ROLE_LABEL: Record<StaffRole, string> = { head: '店責', part: 'パート', support: '応援' };

export function StaffMaster() {
  const [rows, setRows] = useState<Staff[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRow, setNewRow] = useState<{ name: string; store_id: number | null; role: StaffRole }>({
    name: '',
    store_id: null,
    role: 'part',
  });

  const load = async () => {
    setLoading(true);
    const [{ data: s }, { data: st }] = await Promise.all([
      supabase.from('staff').select('*').order('store_id').order('sort_order'),
      supabase.from('stores').select('*').order('id'),
    ]);
    setRows(s || []);
    setStores(st || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const addRow = async () => {
    if (!newRow.name || !newRow.store_id) {
      alert('氏名と所属店舗は必須です');
      return;
    }
    const maxSort = rows.filter((r) => r.store_id === newRow.store_id).length;
    const { error } = await supabase.from('staff').insert({ ...newRow, sort_order: maxSort + 1 });
    if (error) {
      alert(error.message);
      return;
    }
    setNewRow({ name: '', store_id: null, role: 'part' });
    load();
  };

  const toggleActive = async (id: number, current: boolean) => {
    await supabase.from('staff').update({ is_active: !current }).eq('id', id);
    load();
  };

  const storeName = (id: number) => stores.find((s) => s.id === id)?.name || `店舗${id}`;

  if (loading) return <div className="p-8 font-mincho">読み込み中…</div>;

  return (
    <div>
      <table className="w-full border-2 border-ink bg-paper text-sm">
        <thead className="bg-ink text-paper">
          <tr>
            <th className="p-2.5 text-left w-16">ID</th>
            <th className="p-2.5 text-left">氏名</th>
            <th className="p-2.5 text-left">所属店舗</th>
            <th className="p-2.5 text-left">区分</th>
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
              <td className="p-2.5">{storeName(r.store_id)}</td>
              <td className="p-2.5">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.role === 'head' ? 'bg-ink text-paper' : r.role === 'part' ? 'bg-amber-100' : 'bg-paper2'
                }`}>
                  {ROLE_LABEL[r.role]}
                </span>
              </td>
              <td className="p-2.5 text-center font-mono">{r.sort_order}</td>
              <td className="p-2.5 text-center">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.is_active ? 'bg-paper2' : 'bg-stone-300'
                }`}>
                  {r.is_active ? '稼働' : '停止'}
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
        <b className="font-mincho block mb-2.5">＋ 新規スタッフを追加</b>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            placeholder="氏名"
            value={newRow.name}
            onChange={(e) => setNewRow({ ...newRow, name: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm min-w-[160px]"
          />
          <select
            value={newRow.store_id ?? ''}
            onChange={(e) => setNewRow({ ...newRow, store_id: e.target.value ? Number(e.target.value) : null })}
            className="p-2 border-2 border-ink bg-paper text-sm"
          >
            <option value="">所属店舗</option>
            {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select
            value={newRow.role}
            onChange={(e) => setNewRow({ ...newRow, role: e.target.value as StaffRole })}
            className="p-2 border-2 border-ink bg-paper text-sm"
          >
            <option value="head">店責</option>
            <option value="part">パート</option>
            <option value="support">応援</option>
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
