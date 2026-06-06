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

  const saveField = async (id: number, patch: Partial<ReportQuestion>) => {
    const { error } = await supabase.from('report_questions').update(patch).eq('id', id);
    if (error) {
      alert(error.message);
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
            <QuestionRow key={r.id} row={r} onSave={(patch) => saveField(r.id, patch)} />
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
          ※ 表内の「質問内容」「入力タイプ」「初期値」「並び順」は入力後にフィールドから離れた時(フォーカスが外れた時)に保存されます
        </p>
      </div>
    </div>
  );
}

// 1行分のローカル編集ステート
function QuestionRow({
  row,
  onSave,
}: {
  row: ReportQuestion;
  onSave: (patch: Partial<ReportQuestion>) => Promise<void>;
}) {
  const [question, setQuestion] = useState(row.question);
  const [initialValue, setInitialValue] = useState(row.initial_value || '');
  const [sortOrder, setSortOrder] = useState(String(row.sort_order));

  // row が外部更新(load 後)で変わったら同期
  useEffect(() => {
    setQuestion(row.question);
    setInitialValue(row.initial_value || '');
    setSortOrder(String(row.sort_order));
  }, [row.id, row.question, row.initial_value, row.sort_order]);

  const disabled = !row.is_active;

  return (
    <tr className={`border-b border-ink ${disabled ? 'text-stone-400' : ''}`}>
      <td className="p-2.5 font-mono">{row.id}</td>
      <td className="p-2.5">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onBlur={() => {
            const trimmed = question.trim();
            if (!trimmed || trimmed === row.question) return;
            onSave({ question: trimmed });
          }}
          className="w-full p-1 border-1.5 border-ink bg-paper text-sm"
          disabled={disabled}
        />
      </td>
      <td className="p-2.5">
        <select
          value={row.input_type}
          onChange={(e) => onSave({ input_type: e.target.value as ReportInputType })}
          className="p-1 border-1.5 border-ink bg-paper text-xs"
          disabled={disabled}
        >
          {INPUT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
      </td>
      <td className="p-2.5">
        <input
          type="text"
          value={initialValue}
          onChange={(e) => setInitialValue(e.target.value)}
          onBlur={() => {
            if (initialValue === (row.initial_value || '')) return;
            onSave({ initial_value: initialValue || null });
          }}
          className="w-full p-1 border-1.5 border-ink bg-paper text-xs"
          disabled={disabled}
          placeholder="(空欄)"
        />
      </td>
      <td className="p-2.5 text-center">
        <input
          type="number"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
          onBlur={() => {
            const n = Number(sortOrder);
            if (!Number.isFinite(n) || n === row.sort_order) return;
            onSave({ sort_order: n });
          }}
          className="w-16 p-1 border-1.5 border-ink bg-paper text-xs font-mono text-right"
          disabled={disabled}
        />
      </td>
      <td className="p-2.5 text-center">
        <span className={`inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${
          row.is_active ? 'bg-paper2' : 'bg-stone-300'
        }`}>
          {row.is_active ? '有効' : '停止'}
        </span>
      </td>
      <td className="p-2.5 text-center">
        <button
          onClick={() => onSave({ is_active: !row.is_active })}
          className={`text-xs px-2.5 py-1 border-1.5 border-ink font-bold ${
            row.is_active ? 'text-accent border-accent' : ''
          }`}
        >
          {row.is_active ? '停止' : '復帰'}
        </button>
      </td>
    </tr>
  );
}
