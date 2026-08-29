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
    const { error } = await supabase.from('staff').update({ is_active: !current }).eq('id', id);
    if (error) {
      alert(`状態を変更できませんでした: ${error.message}`);
      return;
    }
    load();
  };

  const deleteRow = async (r: Staff) => {
    // shift_entries.staff_id は ON DELETE SET NULL。
    // 削除すると過去シフトの名前が「(未設定)」になるので件数を出して警告する
    const { count } = await supabase
      .from('shift_entries')
      .select('id', { count: 'exact', head: true })
      .eq('staff_id', r.id);

    const used = (count ?? 0) > 0;
    const msg = used
      ? `「${r.name}」は過去のシフト ${count} 件に記録されています。\n削除すると過去の日報・月間レポートで名前が「(未設定)」と表示されます。\n\n退職の場合は履歴が残る「停止」を推奨します。それでも削除しますか?`
      : `「${r.name}」を削除します。よろしいですか?`;
    if (!confirm(msg)) return;

    const { error } = await supabase.from('staff').delete().eq('id', r.id);
    if (error) {
      alert(`削除できませんでした: ${error.message}`);
      return;
    }
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
            <th className="p-2.5 text-center w-32">freee従業員ID</th>
            <th className="p-2.5 text-center">状態</th>
            <th className="p-2.5 text-center w-40">操作</th>
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
              <td className="p-2 text-center">
                <FreeeIdInput row={r} onSaved={load} />
              </td>
              <td className="p-2.5 text-center">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.is_active ? 'bg-paper2' : 'bg-stone-300'
                }`}>
                  {r.is_active ? '稼働' : '停止'}
                </span>
              </td>
              <td className="p-2.5 text-center whitespace-nowrap">
                <button
                  onClick={() => toggleActive(r.id, r.is_active)}
                  className={`text-xs px-2.5 py-1 border-1.5 border-ink font-bold mr-1.5 ${
                    r.is_active ? 'text-accent border-accent' : ''
                  }`}
                >
                  {r.is_active ? '停止' : '復帰'}
                </button>
                <button
                  onClick={() => deleteRow(r)}
                  className="text-xs px-2.5 py-1 border-1.5 border-accent text-paper bg-accent font-bold"
                >
                  削除
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

// freee人事労務の従業員ID。フォーカスが外れた時に保存する
function FreeeIdInput({ row, onSaved }: { row: Staff; onSaved: () => void }) {
  const [value, setValue] = useState(
    row.freee_employee_id === null || row.freee_employee_id === undefined
      ? ''
      : String(row.freee_employee_id)
  );

  useEffect(() => {
    setValue(
      row.freee_employee_id === null || row.freee_employee_id === undefined
        ? ''
        : String(row.freee_employee_id)
    );
  }, [row.id, row.freee_employee_id]);

  const save = async () => {
    const trimmed = value.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    if (next !== null && !Number.isInteger(next)) {
      alert('freee従業員IDは整数で入力してください');
      return;
    }
    if (next === (row.freee_employee_id ?? null)) return;

    const { error } = await supabase
      .from('staff')
      .update({ freee_employee_id: next })
      .eq('id', row.id);
    if (error) {
      alert(`保存できませんでした: ${error.message}`);
      return;
    }
    onSaved();
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ''))}
      onBlur={save}
      placeholder="未設定"
      className="w-24 p-1 border-1.5 border-ink bg-paper text-xs font-mono text-center"
    />
  );
}
