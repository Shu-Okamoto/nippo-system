'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { Product } from '@/lib/types';

const CATEGORIES = ['豆類', '穀類', '漬物', 'みそ', 'お茶', 'その他'];

type EditState = {
  id: number;
  name: string;
  category: string;
  sort_order: number;
};

export function ProductsMaster() {
  const [rows, setRows] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRow, setNewRow] = useState({ name: '', category: '豆類' });
  const [edit, setEdit] = useState<EditState | null>(null);
  const [busy, setBusy] = useState(false);

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
    const { error } = await supabase
      .from('products')
      .update({ is_active: !current })
      .eq('id', id);
    if (error) {
      alert(`状態を変更できませんでした: ${error.message}`);
      return;
    }
    load();
  };

  const saveEdit = async () => {
    if (!edit) return;
    if (!edit.name.trim()) {
      alert('商品名は必須です');
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from('products')
      .update({
        name: edit.name.trim(),
        category: edit.category,
        sort_order: edit.sort_order,
      })
      .eq('id', edit.id);
    setBusy(false);
    if (error) {
      alert(`保存できませんでした: ${error.message}`);
      return;
    }
    setEdit(null);
    load();
  };

  const deleteRow = async (r: Product) => {
    // 過去の注文で使われているか確認してから警告文を出し分ける
    const { count } = await supabase
      .from('order_lines')
      .select('id', { count: 'exact', head: true })
      .eq('product_id', r.id);

    const used = (count ?? 0) > 0;
    const msg = used
      ? `「${r.name}」は過去の注文 ${count} 件で使用されています。\n削除すると過去の日報・注文票で商品名が「(不明)」と表示されます。\n\n履歴を残すには「停止」を推奨します。それでも削除しますか?`
      : `「${r.name}」を削除します。よろしいですか?`;
    if (!confirm(msg)) return;

    setBusy(true);
    const { error } = await supabase.from('products').delete().eq('id', r.id);
    setBusy(false);
    if (error) {
      alert(`削除できませんでした: ${error.message}`);
      return;
    }
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
            <th className="p-2.5 text-center w-48">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) =>
            edit?.id === r.id ? (
              <tr key={r.id} className="border-b border-ink bg-paper2">
                <td className="p-2.5 font-mono">{r.id}</td>
                <td className="p-2">
                  <input
                    value={edit.name}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                    className="w-full p-1.5 border-2 border-ink bg-paper text-sm"
                    autoFocus
                  />
                </td>
                <td className="p-2">
                  <select
                    value={edit.category}
                    onChange={(e) => setEdit({ ...edit, category: e.target.value })}
                    className="p-1.5 border-2 border-ink bg-paper text-sm"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td className="p-2 text-center">
                  <input
                    type="number"
                    value={edit.sort_order}
                    onChange={(e) =>
                      setEdit({ ...edit, sort_order: Number(e.target.value) || 0 })
                    }
                    className="w-16 p-1.5 border-2 border-ink bg-paper text-sm font-mono text-center"
                  />
                </td>
                <td className="p-2.5 text-center">
                  <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                    r.is_active ? 'bg-paper2' : 'bg-stone-300'
                  }`}>
                    {r.is_active ? '取扱中' : '停止'}
                  </span>
                </td>
                <td className="p-2.5 text-center whitespace-nowrap">
                  <button
                    onClick={saveEdit}
                    disabled={busy}
                    className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold bg-ink text-paper mr-1.5"
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEdit(null)}
                    disabled={busy}
                    className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold"
                  >
                    取消
                  </button>
                </td>
              </tr>
            ) : (
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
                <td className="p-2.5 text-center whitespace-nowrap">
                  <button
                    onClick={() =>
                      setEdit({
                        id: r.id,
                        name: r.name,
                        category: r.category,
                        sort_order: r.sort_order,
                      })
                    }
                    className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold mr-1.5"
                  >
                    編集
                  </button>
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
                    disabled={busy}
                    className="text-xs px-2.5 py-1 border-1.5 border-accent text-paper bg-accent font-bold"
                  >
                    削除
                  </button>
                </td>
              </tr>
            )
          )}
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
