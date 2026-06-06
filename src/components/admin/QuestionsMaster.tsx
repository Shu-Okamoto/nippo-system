'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ReportQuestion, ReportInputType } from '@/lib/types';

const INPUT_TYPES: { value: ReportInputType; label: string }[] = [
  { value: 'text',     label: 'text(一行)' },
  { value: 'textarea', label: 'textarea(複数行)' },
  { value: 'number',   label: 'number(数値)' },
  { value: 'checkbox', label: 'checkbox' },
];

export function QuestionsMaster() {
  const [rows, setRows] = useState<ReportQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRow, setNewRow] = useState<{
    question: string;
    input_type: ReportInputType;
    initial_value: string;
  }>({ question: '', input_type: 'textarea', initial_value: '' });

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from('report_questions')
      .select('*')
      .order('sort_order');
    setRows((data || []) as ReportQuestion[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const addRow = async () => {
    if (!newRow.question.trim()) {
      alert('質問内容は必須です');
      return;
    }
    const maxSort = Math.max(0, ...rows.map((r) => r.sort_order));
    const { error } = await supabase.from('report_questions').insert({
      question: newRow.question.trim(),
      input_type: newRow.input_type,
      initial_value: newRow.initial_value || null,
      sort_order: maxSort + 10,
    });
    if (error) {
      alert(error.message);
      return;
    }
    setNewRow({ question: '', input_type: 'textarea', initial_value: '' });
    load();
  };

  const toggleActive = async (id: number, current: boolean) => {
    await supabase.from('report_questions').update({ is_active: !current }).eq('id', id);
    load();
  };

  const updateField = async (id: number, patch: Partial<ReportQuestion>) => {
    await supabase.from('report_questions').update(patch).eq('id', id);
    load();
  };

  if (loading) return <div className="p-8 font-mincho">読み込み中…</div>;

  return (
    <div>
      <table className="w-full border-2 border-ink bg-paper text-sm">
        <thead className="bg-ink text-paper">
          <tr>
            <th className="p-2.5 text-left w-16">ID</th>
            <th className="p-2.5 text-left">質問内容</th>
            <th className="p-2.5 text-left w-40">入力タイプ</th>
            <th className="p-2.5 text-left">初期値</th>
            <th className="p-2.5 text-center w-20">並び順</th>
            <th className="p-2.5 text-center w-20">状態</th>
            <th className="p-2.5 text-center w-24">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-b border-ink ${!r.is_active ? 'text-stone-400' : ''}`}>
              <td className="p-2.5 font-mono">{r.id}</td>
              <td className="p-2.5">{r.question}</td>
              <td className="p-2.5">
                <select
                  value={r.input_type}
                  onChange={(e) => updateField(r.id, { input_type: e.target.value as ReportInputType })}
                  className="p-1 border-1.5 border-ink bg-paper text-xs"
                  disabled={!r.is_active}
                >
                  {INPUT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </td>
              <td className="p-2.5">
                <input
                  type="text"
                  value={r.initial_value || ''}
                  onChange={(e) => updateField(r.id, { initial_value: e.target.value || null })}
                  className="w-full p-1 border-1.5 border-ink bg-paper text-xs"
                  disabled={!r.is_active}
                  placeholder="(空欄)"
                />
              </td>
              <td className="p-2.5 text-center">
                <input
                  type="number"
                  value={r.sort_order}
                  onChange={(e) => updateField(r.id, { sort_order: Number(e.target.value) })}
                  className="w-16 p-1 border-1.5 border-ink bg-paper text-xs font-mono text-right"
                  disabled={!r.is_active}
                />
              </td>
              <td className="p-2.5 text-center">
                <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
                  r.is_active ? 'bg-paper2' : 'bg-stone-300'
                }`}>
                  {r.is_active ? '有効' : '停止'}
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
        <b className="font-mincho block mb-2.5">＋ 新しい質問を追加</b>
        <div className="flex gap-2 flex-wrap items-center">
          <input
            placeholder="質問内容(例: 来店客の傾向)"
            value={newRow.question}
            onChange={(e) => setNewRow({ ...newRow, question: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm min-w-[260px]"
          />
          <select
            value={newRow.input_type}
            onChange={(e) =>
              setNewRow({ ...newRow, input_type: e.target.value as ReportInputType })
            }
            className="p-2 border-2 border-ink bg-paper text-sm"
          >
            {INPUT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <input
            placeholder="初期値(任意)"
            value={newRow.initial_value}
            onChange={(e) => setNewRow({ ...newRow, initial_value: e.target.value })}
            className="p-2 border-2 border-ink bg-paper text-sm min-w-[180px]"
          />
          <button
            onClick={addRow}
            className="px-4 py-2 bg-ink text-paper border-2 border-ink font-mincho font-bold text-sm"
          >
            追加
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          ※ 表内の「入力タイプ」「初期値」「並び順」はその場で直接編集できます(停止中は不可)
        </p>
      </div>
    </div>
  );
}
