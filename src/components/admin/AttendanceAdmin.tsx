'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { shiftMinutes } from '@/lib/calc';
import type { ClockEventType, ShiftEntry, Staff, Store } from '@/lib/types';

const EVENT_LABEL: Record<ClockEventType, string> = {
  clock_in: '出勤',
  break_begin: '休憩入',
  break_end: '休憩戻',
  clock_out: '退勤',
};

const EVENT_TYPES: ClockEventType[] = ['clock_in', 'break_begin', 'break_end', 'clock_out'];

const FREEE_LABEL: Record<string, string> = {
  pending: '未送信',
  sent: '送信済',
  skipped: '対象外',
  error: 'エラー',
  manual: '要手動修正',
};

type EventRow = {
  id: number;
  store_id: number;
  staff_id: number;
  work_date: string;
  event_type: ClockEventType;
  event_at: string;
  source: string;
  note: string | null;
  is_voided: boolean;
  edited_at: string | null;
  freee_status: string;
  freee_error: string | null;
  staff: { name: string } | null;
};

type SummaryRow = {
  staff_id: number | null;
  name: string;
  start: string | null;
  end: string | null;
  breakMin: number;
  hours: number;
};

type SyncInfo = {
  configured: boolean;
  pending?: number;
  errored?: number;
  message?: string;
};

function jstTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
}

function todayJst(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export function AttendanceAdmin() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [date, setDate] = useState(todayJst);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [showVoided, setShowVoided] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // インライン編集
  const [editId, setEditId] = useState<number | null>(null);
  const [editType, setEditType] = useState<ClockEventType>('clock_in');
  const [editTime, setEditTime] = useState('');

  // 打刻の追加
  const [addStaffId, setAddStaffId] = useState<number | null>(null);
  const [addType, setAddType] = useState<ClockEventType>('clock_in');
  const [addTime, setAddTime] = useState('09:00');

  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const slug = stores.find((s) => s.id === storeId)?.slug ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    const { data: st } = await supabase.from('stores').select('*').order('id');
    const storeList = (st || []) as Store[];
    setStores(storeList);
    const sid = storeId ?? storeList[0]?.id ?? null;
    if (storeId === null && sid !== null) setStoreId(sid);

    if (sid === null) {
      setRows([]);
      setSummary([]);
      setLoading(false);
      return;
    }

    // 退職者の打刻もれを補うこともあるので全スタッフを対象にする
    const { data: sf } = await supabase
      .from('staff')
      .select('*')
      .eq('store_id', sid)
      .order('sort_order');
    setStaffList((sf || []) as Staff[]);

    const { data, error: e } = await supabase
      .from('time_clock_events')
      .select('*, staff(name)')
      .eq('store_id', sid)
      .eq('work_date', date)
      .order('event_at');

    if (e) {
      setError(e.message);
      setRows([]);
    } else {
      setError(null);
      setRows((data || []) as EventRow[]);
    }

    // 打刻から組み立てられた実績シフト(修正結果の確認用)
    const { data: rep } = await supabase
      .from('daily_reports')
      .select('id')
      .eq('store_id', sid)
      .eq('report_date', date)
      .maybeSingle();

    if (rep?.id) {
      const { data: shifts } = await supabase
        .from('shift_entries')
        .select('*, staff(name, sort_order)')
        .eq('daily_report_id', rep.id)
        .eq('entry_type', 'actual');

      const list: SummaryRow[] = ((shifts || []) as any[])
        .map((s) => ({
          staff_id: s.staff_id,
          name: s.staff?.name || s.staff_name_manual || '(未設定)',
          start: s.start_time ? String(s.start_time).slice(0, 5) : null,
          end: s.end_time ? String(s.end_time).slice(0, 5) : null,
          breakMin: s.break_minutes ?? 0,
          hours: shiftMinutes(s as ShiftEntry) / 60,
          sort: s.staff?.sort_order ?? 9999,
        }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ sort, ...r }) => r);
      setSummary(list);
    } else {
      setSummary([]);
    }

    setLoading(false);
  }, [storeId, date]);

  useEffect(() => {
    load();
  }, [load]);

  const loadSyncInfo = useCallback(async () => {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) return;
    try {
      const res = await fetch('/api/freee/sync', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setSync(await res.json());
    } catch {
      setSync(null);
    }
  }, []);

  useEffect(() => {
    loadSyncInfo();
  }, [loadSyncInfo]);

  // supabase.rpc() は Promise ではなく thenable を返すので PromiseLike で受ける
  const run = async (fn: () => PromiseLike<{ error: any }>, failMsg: string) => {
    setBusy(true);
    const { error: e } = await fn();
    setBusy(false);
    if (e) {
      alert(`${failMsg}: ${e.message}`);
      return false;
    }
    await load();
    return true;
  };

  const startEdit = (r: EventRow) => {
    setEditId(r.id);
    setEditType(r.event_type);
    setEditTime(jstTime(r.event_at));
  };

  const saveEdit = async () => {
    if (editId === null) return;
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(editTime)) {
      alert('時刻は HH:MM 形式で入力してください');
      return;
    }
    const ok = await run(
      () =>
        supabase.rpc('update_punch', {
          p_event_id: editId,
          p_event_type: editType,
          p_time: editTime,
        }),
      '修正できませんでした'
    );
    if (ok) setEditId(null);
  };

  const removeEvent = async (r: EventRow) => {
    const label = `${r.staff?.name ?? r.staff_id} さんの ${EVENT_LABEL[r.event_type]} ${jstTime(r.event_at)}`;
    const warn =
      r.freee_status === 'sent'
        ? '\n\n※この打刻は freee に送信済みです。freee 側は自動で消えないので手動で削除してください。'
        : '';
    if (!confirm(`${label} を削除します。実績シフトも組み立て直されます。${warn}`)) return;
    await run(() => supabase.rpc('delete_punch', { p_event_id: r.id }), '削除できませんでした');
  };

  const restoreEvent = async (r: EventRow) => {
    await run(() => supabase.rpc('restore_punch', { p_event_id: r.id }), '復元できませんでした');
  };

  const addEvent = async () => {
    if (!slug || addStaffId === null) {
      alert('メンバーを選択してください');
      return;
    }
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(addTime)) {
      alert('時刻は HH:MM 形式で入力してください');
      return;
    }
    await run(
      () =>
        supabase.rpc('add_punch', {
          p_slug: slug,
          p_staff_id: addStaffId,
          p_work_date: date,
          p_event_type: addType,
          p_time: addTime,
          p_note: '管理画面から追加',
        }),
      '追加できませんでした'
    );
  };

  const runSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      setSyncResult('ログインし直してください');
      setSyncing(false);
      return;
    }
    try {
      const res = await fetch('/api/freee/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (j.error) setSyncResult(`エラー: ${j.error}`);
      else if (j.configured === false) setSyncResult(j.message || 'freee 連携は未設定です');
      else
        setSyncResult(
          `送信 ${j.sent} 件 / 対象外 ${j.skipped} 件 / 失敗 ${j.failed} 件` +
            (j.errors?.length ? `\n${j.errors.join('\n')}` : '')
        );
    } catch (err: any) {
      setSyncResult(`エラー: ${err.message}`);
    }
    setSyncing(false);
    loadSyncInfo();
    load();
  };

  const visible = showVoided ? rows : rows.filter((r) => !r.is_voided);
  const voidedCount = rows.filter((r) => r.is_voided).length;

  return (
    <div>
      <div className="flex flex-wrap gap-3 items-center mb-4">
        <div className="flex border-2 border-ink">
          {stores.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setStoreId(s.id);
                setEditId(null);
                setAddStaffId(null);
              }}
              className={`px-4 py-2 font-mincho font-bold text-sm border-r-2 border-ink last:border-r-0 ${
                storeId === s.id ? 'bg-ink text-paper' : 'bg-paper'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        <input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setEditId(null);
          }}
          className="border-2 border-ink p-2 font-mono"
        />
        <button onClick={load} className="px-3 py-2 border-2 border-ink font-bold text-sm">
          ↻ 更新
        </button>
        <label className="flex items-center gap-1.5 text-sm font-bold">
          <input
            type="checkbox"
            checked={showVoided}
            onChange={(e) => setShowVoided(e.target.checked)}
            className="w-4 h-4 border-2 border-ink"
          />
          削除済も表示{voidedCount > 0 && `(${voidedCount})`}
        </label>
      </div>

      {error && <div className="mb-3 text-sm text-accent font-bold">⚠ {error}</div>}

      {/* 修正結果の確認用サマリー */}
      {summary.length > 0 && (
        <div className="mb-5 border-2 border-ink bg-paper2">
          <div className="px-3 py-2 bg-ink text-paper font-mincho font-bold text-sm">
            この日の実績(打刻から自動計算)
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-muted font-mincho font-bold border-b border-ink">
                <th className="text-left p-2">メンバー</th>
                <th className="text-center p-2 w-20">出勤</th>
                <th className="text-center p-2 w-20">退勤</th>
                <th className="text-center p-2 w-20">休憩</th>
                <th className="text-right p-2 w-24">実働</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s, i) => (
                <tr key={i} className="border-b border-dotted border-stone-300">
                  <td className="p-2 font-bold">{s.name}</td>
                  <td className="p-2 text-center font-mono">{s.start ?? '—'}</td>
                  <td className="p-2 text-center font-mono">
                    {s.end ?? <span className="text-accent font-bold">未</span>}
                  </td>
                  <td className="p-2 text-center font-mono">{s.breakMin ? `${s.breakMin}分` : '—'}</td>
                  <td className="p-2 text-right font-mono font-bold">{s.hours.toFixed(1)}h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading ? (
        <div className="p-8 font-mincho">読み込み中…</div>
      ) : visible.length === 0 ? (
        <div className="border-2 border-ink p-10 text-center font-mincho text-muted">
          この日の打刻はありません
        </div>
      ) : (
        <table className="w-full border-2 border-ink bg-paper text-sm">
          <thead className="bg-ink text-paper">
            <tr>
              <th className="p-2.5 text-left w-24">時刻</th>
              <th className="p-2.5 text-left">メンバー</th>
              <th className="p-2.5 text-left w-32">打刻</th>
              <th className="p-2.5 text-left w-28">freee</th>
              <th className="p-2.5 text-center w-40">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) =>
              editId === r.id ? (
                <tr key={r.id} className="border-b border-ink bg-paper2">
                  <td className="p-2">
                    <input
                      value={editTime}
                      onChange={(e) => setEditTime(e.target.value)}
                      placeholder="HH:MM"
                      className="w-20 p-1.5 border-2 border-ink bg-paper text-sm font-mono text-center"
                      autoFocus
                    />
                  </td>
                  <td className="p-2.5 font-bold">{r.staff?.name ?? `ID:${r.staff_id}`}</td>
                  <td className="p-2">
                    <select
                      value={editType}
                      onChange={(e) => setEditType(e.target.value as ClockEventType)}
                      className="p-1.5 border-2 border-ink bg-paper text-sm"
                    >
                      {EVENT_TYPES.map((t) => (
                        <option key={t} value={t}>{EVENT_LABEL[t]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2.5" />
                  <td className="p-2.5 text-center whitespace-nowrap">
                    <button
                      onClick={saveEdit}
                      disabled={busy}
                      className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold bg-ink text-paper mr-1.5"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      disabled={busy}
                      className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold"
                    >
                      取消
                    </button>
                  </td>
                </tr>
              ) : (
                <tr
                  key={r.id}
                  className={`border-b border-ink ${r.is_voided ? 'text-stone-400' : ''}`}
                >
                  <td className={`p-2.5 font-mono ${r.is_voided ? 'line-through' : ''}`}>
                    {jstTime(r.event_at)}
                  </td>
                  <td className="p-2.5 font-bold">{r.staff?.name ?? `ID:${r.staff_id}`}</td>
                  <td className="p-2.5">
                    <span className="inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink bg-paper2">
                      {EVENT_LABEL[r.event_type]}
                    </span>
                    {r.source === 'admin' && (
                      <span className="ml-1 text-[9px] font-bold px-1 border border-ink bg-amber-100 font-mono">
                        手動
                      </span>
                    )}
                    {r.source !== 'admin' && r.edited_at && (
                      <span className="ml-1 text-[9px] font-bold px-1 border border-ink bg-amber-100 font-mono">
                        修正
                      </span>
                    )}
                  </td>
                  <td className="p-2.5 text-xs">
                    <span
                      className={`inline-block px-2 py-0.5 font-bold border-1.5 border-ink ${
                        r.freee_status === 'sent'
                          ? 'bg-accent2 text-paper'
                          : r.freee_status === 'error' || r.freee_status === 'manual'
                          ? 'bg-accent text-paper'
                          : 'bg-paper2'
                      }`}
                      title={r.freee_error || ''}
                    >
                      {FREEE_LABEL[r.freee_status] ?? r.freee_status}
                    </span>
                  </td>
                  <td className="p-2.5 text-center whitespace-nowrap">
                    {r.is_voided ? (
                      <button
                        onClick={() => restoreEvent(r)}
                        disabled={busy}
                        className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold"
                      >
                        復元
                      </button>
                    ) : (
                      <>
                        <button
                          onClick={() => startEdit(r)}
                          disabled={busy}
                          className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold mr-1.5"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => removeEvent(r)}
                          disabled={busy}
                          className="text-xs px-2.5 py-1 border-1.5 border-accent text-paper bg-accent font-bold"
                        >
                          削除
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      )}

      {/* 打刻もれの追加 */}
      <div className="mt-4 p-4 bg-paper2 border-2 border-dashed border-ink">
        <b className="font-mincho block mb-2.5">＋ 打刻を追加(打刻もれの補完)</b>
        <div className="flex gap-2 flex-wrap items-center">
          <select
            value={addStaffId ?? ''}
            onChange={(e) => setAddStaffId(e.target.value ? Number(e.target.value) : null)}
            className="p-2 border-2 border-ink bg-paper text-sm min-w-[160px]"
          >
            <option value="">メンバーを選択</option>
            {staffList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.is_active ? '' : '(停止中)'}
              </option>
            ))}
          </select>
          <select
            value={addType}
            onChange={(e) => setAddType(e.target.value as ClockEventType)}
            className="p-2 border-2 border-ink bg-paper text-sm"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{EVENT_LABEL[t]}</option>
            ))}
          </select>
          <input
            value={addTime}
            onChange={(e) => setAddTime(e.target.value)}
            placeholder="HH:MM"
            className="p-2 border-2 border-ink bg-paper text-sm font-mono w-24 text-center"
          />
          <button
            onClick={addEvent}
            disabled={busy}
            className="px-4 py-2 bg-ink text-paper border-2 border-ink font-mincho font-bold text-sm disabled:bg-stone-400"
          >
            追加
          </button>
          <span className="text-xs text-muted">対象日: {date}</span>
        </div>
      </div>

      <div className="mt-6 p-4 bg-paper2 border-2 border-dashed border-ink">
        <b className="font-mincho block mb-2.5">freee人事労務 連携</b>
        {sync?.configured === false ? (
          <p className="text-sm text-muted">
            未設定です。Vercel の環境変数に FREEE_CLIENT_ID / FREEE_CLIENT_SECRET /
            FREEE_COMPANY_ID / FREEE_INITIAL_REFRESH_TOKEN / SUPABASE_SERVICE_ROLE_KEY
            を設定すると有効になります。
          </p>
        ) : (
          <>
            <p className="text-sm mb-3">
              未送信 <b className="font-mono">{sync?.pending ?? '—'}</b> 件 / エラー{' '}
              <b className="font-mono">{sync?.errored ?? '—'}</b> 件
              <span className="block text-xs text-muted mt-1">
                スタッフマスタで freee 従業員ID を設定した人の打刻のみ送信されます。
                「要手動修正」は freee 送信後に直した打刻です。freee 側は手で直してください。
              </span>
            </p>
            <button
              onClick={runSync}
              disabled={syncing}
              className="px-4 py-2 bg-ink text-paper border-2 border-ink font-mincho font-bold text-sm disabled:bg-stone-400"
            >
              {syncing ? '送信中…' : 'freee に送信'}
            </button>
          </>
        )}
        {syncResult && (
          <pre className="mt-3 text-xs whitespace-pre-wrap font-mono bg-paper border-2 border-ink p-2">
            {syncResult}
          </pre>
        )}
      </div>
    </div>
  );
}
