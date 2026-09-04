'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatMinutesAsHours } from '@/lib/calc';
import type { ClockEventType, Staff, Store } from '@/lib/types';

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
  staff_name: string | null;
  work_date: string;
  event_type: ClockEventType;
  event_at: string;
  source: string;
  note: string | null;
  is_voided: boolean;
  edited_at: string | null;
  freee_status: string;
  freee_error: string | null;
};

type BreakSpan = { begin: string; end: string | null };

type SummaryRow = {
  staff_id: number;
  name: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  work_minutes: number | null;
  breaks: BreakSpan[];
};

type MonthDay = {
  date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  work_minutes: number | null;
  breaks: BreakSpan[];
  event_count: number;
};

type MonthData = {
  staff_id: number;
  staff_name: string;
  days: MonthDay[];
  total_work_minutes: number;
  work_days: number;
};

type SyncInfo = {
  configured: boolean;
  connected?: boolean;
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

// "YYYY-MM-DD" を日数ぶんずらす。タイムゾーンの影響を避けるため UTC で計算する
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function AttendanceAdmin() {
  const [view, setView] = useState<'day' | 'month'>('day');
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

  // 月別ビュー(メンバー1人の1か月)
  const [month, setMonth] = useState(() => todayJst().slice(0, 7));
  const [monthStaffId, setMonthStaffId] = useState<number | null>(null);
  const [monthData, setMonthData] = useState<MonthData | null>(null);
  const [monthLoading, setMonthLoading] = useState(false);

  // 月別から日別へ移った時に、その人だけを表示するための絞り込み
  const [focusStaffId, setFocusStaffId] = useState<number | null>(null);

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
  const [employees, setEmployees] = useState<
    { id: number; name: string; num: string | null }[] | null
  >(null);
  const [empLoading, setEmpLoading] = useState(false);
  const [diag, setDiag] = useState<string | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);

  const slug = stores.find((s) => s.id === storeId)?.slug ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    // 停止中の店舗は表示しない。打刻系の RPC も is_active な店舗しか
    // 受け付けないため、選べてしまうとエラーになる
    const { data: st } = await supabase
      .from('stores')
      .select('*')
      .eq('is_active', true)
      .order('id');
    const storeList = (st || []) as Store[];
    setStores(storeList);

    // 選択中の店舗が停止された場合は先頭の稼働店舗に戻す
    const stillActive = storeList.some((s) => s.id === storeId);
    const sid = stillActive ? storeId : storeList[0]?.id ?? null;
    if (sid !== storeId) setStoreId(sid);

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

    const storeSlug = storeList.find((s) => s.id === sid)?.slug;
    if (!storeSlug) {
      setRows([]);
      setSummary([]);
      setLoading(false);
      return;
    }

    // 打刻一覧・集計とも SECURITY DEFINER の RPC 経由で取る。
    // テーブルを直接読むとロールの権限設定に左右されるため
    const { data: ev, error: e } = await supabase.rpc('get_punch_events', {
      p_slug: storeSlug,
      p_date: date,
      p_include_voided: true,
    });

    if (e) {
      setError(e.message);
      setRows([]);
    } else {
      setError(null);
      setRows((((ev as any)?.events ?? []) as EventRow[]));
    }

    // 打刻の日次集計。日報の実績入力とは無関係にイベントログから計算する
    const { data: sum } = await supabase.rpc('get_attendance_summary', {
      p_slug: storeSlug,
      p_date: date,
    });
    setSummary(((sum as any)?.members ?? []) as SummaryRow[]);

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

  // 月別ビューの読み込み
  const loadMonth = useCallback(async () => {
    if (!slug || monthStaffId === null) {
      setMonthData(null);
      return;
    }
    setMonthLoading(true);
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

    const { data, error: e } = await supabase.rpc('get_attendance_month', {
      p_slug: slug,
      p_staff_id: monthStaffId,
      p_from: from,
      p_to: to,
    });
    if (e) {
      setError(e.message);
      setMonthData(null);
    } else {
      setError(null);
      setMonthData(data as MonthData);
    }
    setMonthLoading(false);
  }, [slug, monthStaffId, month]);

  useEffect(() => {
    if (view === 'month') loadMonth();
  }, [view, loadMonth]);

  const goToDate = (next: string) => {
    if (!next) return;
    setDate(next);
    setEditId(null);
  };

  // 月別の行クリック → その日・そのメンバーの編集画面へ
  const openDayDetail = (d: MonthDay) => {
    setDate(d.date);
    setFocusStaffId(monthStaffId);
    setAddStaffId(monthStaffId);
    setEditId(null);
    setView('day');
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
    const label = `${r.staff_name ?? r.staff_id} さんの ${EVENT_LABEL[r.event_type]} ${jstTime(r.event_at)}`;
    const warn =
      r.freee_status === 'sent'
        ? '\n\n※この打刻は freee に送信済みです。freee 側は自動で消えないので手動で削除してください。'
        : '';
    if (!confirm(`${label} を削除します。${warn}`)) return;
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

  const loadEmployees = async () => {
    setEmpLoading(true);
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      setEmpLoading(false);
      alert('ログインし直してください');
      return;
    }
    try {
      const res = await fetch('/api/freee/employees', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json();
      if (j.error) alert(`従業員一覧を取得できませんでした: ${j.error}`);
      else setEmployees(j.employees ?? []);
    } catch (err: any) {
      alert(`従業員一覧を取得できませんでした: ${err.message}`);
    }
    setEmpLoading(false);
  };

  const runDiag = async () => {
    setDiagLoading(true);
    setDiag(null);
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) {
      setDiagLoading(false);
      setDiag('ログインし直してください');
      return;
    }
    try {
      const res = await fetch('/api/freee/diag', {
        headers: { Authorization: `Bearer ${token}` },
      });
      setDiag(JSON.stringify(await res.json(), null, 2));
    } catch (err: any) {
      setDiag(`エラー: ${err.message}`);
    }
    setDiagLoading(false);
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

  const scoped = focusStaffId === null ? rows : rows.filter((r) => r.staff_id === focusStaffId);
  const visible = showVoided ? scoped : scoped.filter((r) => !r.is_voided);
  const voidedCount = scoped.filter((r) => r.is_voided).length;
  const focusName = staffList.find((s) => s.id === focusStaffId)?.name;
  const visibleSummary =
    focusStaffId === null ? summary : summary.filter((s) => s.staff_id === focusStaffId);

  return (
    <div>
      {/* 日別 / 月別 の切替 */}
      <div className="flex border-2 border-ink mb-4 w-fit">
        {([
          { k: 'day' as const, label: '日別(店舗)' },
          { k: 'month' as const, label: '月別(メンバー)' },
        ]).map((v) => (
          <button
            key={v.k}
            onClick={() => setView(v.k)}
            className={`px-5 py-2.5 font-mincho font-bold text-sm border-r-2 border-ink last:border-r-0 ${
              view === v.k ? 'bg-ink text-paper' : 'bg-paper'
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-3 items-center mb-4">
        <div className="flex border-2 border-ink">
          {stores.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setStoreId(s.id);
                setEditId(null);
                setAddStaffId(null);
                setMonthStaffId(null);
                setFocusStaffId(null);
              }}
              className={`px-4 py-2 font-mincho font-bold text-sm border-r-2 border-ink last:border-r-0 ${
                storeId === s.id ? 'bg-ink text-paper' : 'bg-paper'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
        {view === 'day' ? (
          <>
            <div className="flex items-center border-2 border-ink">
              <button
                onClick={() => goToDate(shiftDate(date, -1))}
                className="px-3 py-2 font-bold border-r-2 border-ink hover:bg-paper2"
                title="前日"
              >
                ‹
              </button>
              <input
                type="date"
                value={date}
                onChange={(e) => goToDate(e.target.value)}
                className="p-2 font-mono border-r-2 border-ink"
              />
              <button
                onClick={() => goToDate(shiftDate(date, 1))}
                className="px-3 py-2 font-bold border-r-2 border-ink hover:bg-paper2"
                title="翌日"
              >
                ›
              </button>
              <button
                onClick={() => goToDate(todayJst())}
                className="px-3 py-2 font-bold text-sm hover:bg-paper2"
              >
                今日
              </button>
            </div>
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
          </>
        ) : (
          <>
            <input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="border-2 border-ink p-2 font-mono"
            />
            <select
              value={monthStaffId ?? ''}
              onChange={(e) => setMonthStaffId(e.target.value ? Number(e.target.value) : null)}
              className="p-2 border-2 border-ink bg-paper text-sm min-w-[180px]"
            >
              <option value="">メンバーを選択</option>
              {staffList.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.is_active ? '' : '(停止中)'}
                </option>
              ))}
            </select>
            <button onClick={loadMonth} className="px-3 py-2 border-2 border-ink font-bold text-sm">
              ↻ 更新
            </button>
          </>
        )}
      </div>

      {/* 月別から来た時の絞り込み表示 */}
      {view === 'day' && focusStaffId !== null && (
        <div className="mb-4 flex items-center gap-3 px-3 py-2 border-2 border-ink bg-gold">
          <span className="font-mincho font-bold text-sm">
            {focusName ?? `ID:${focusStaffId}`} さんで絞り込み中
          </span>
          <button
            onClick={() => setFocusStaffId(null)}
            className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold bg-paper hover:bg-paper2"
          >
            × 解除して全員表示
          </button>
          <button
            onClick={() => setView('month')}
            className="text-xs px-2.5 py-1 border-1.5 border-ink font-bold bg-paper hover:bg-paper2"
          >
            ← 月別に戻る
          </button>
        </div>
      )}

      {error && <div className="mb-3 text-sm text-accent font-bold">⚠ {error}</div>}

      {view === 'month' && (
        <MonthView
          data={monthData}
          loading={monthLoading}
          staffSelected={monthStaffId !== null}
          onRowClick={openDayDetail}
        />
      )}

      {view === 'day' && (
      <>
      {/* 修正結果の確認用サマリー */}
      {visibleSummary.length > 0 && (
        <div className="mb-5 border-2 border-ink bg-paper2">
          <div className="px-3 py-2 bg-ink text-paper font-mincho font-bold text-sm">
            この日の勤怠集計(打刻から計算)
            <span className="ml-2 text-[10px] font-normal opacity-70">
              ※日報の実績入力とは別管理です
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-muted font-mincho font-bold border-b border-ink">
                <th className="text-left p-2">メンバー</th>
                <th className="text-center p-2 w-20">出勤</th>
                <th className="text-center p-2 w-32">休憩入〜戻</th>
                <th className="text-center p-2 w-20">退勤</th>
                <th className="text-center p-2 w-20">休憩計</th>
                <th className="text-right p-2 w-24">実働</th>
              </tr>
            </thead>
            <tbody>
              {visibleSummary.map((s) => (
                <tr key={s.staff_id} className="border-b border-dotted border-stone-300">
                  <td className="p-2 font-bold">{s.name}</td>
                  <td className="p-2 text-center font-mono">{s.start_time ?? '—'}</td>
                  <td className="p-2 text-center font-mono text-xs">
                    <BreakSpans breaks={s.breaks} />
                  </td>
                  <td className="p-2 text-center font-mono">
                    {s.end_time ?? <span className="text-accent font-bold">未</span>}
                  </td>
                  <td className="p-2 text-center font-mono">
                    {s.break_minutes ? `${s.break_minutes}分` : '—'}
                  </td>
                  <td className="p-2 text-right font-mono font-bold">
                    {s.work_minutes !== null ? `${formatMinutesAsHours(s.work_minutes)}h` : '—'}
                  </td>
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
          {error ? (
            <span className="text-accent font-bold">
              打刻を読み込めませんでした: {error}
            </span>
          ) : summary.length > 0 ? (
            // 集計に出ているのに一覧が空 = 取得経路の問題。黙って
            // 「打刻なし」と出すと誤解を招くので明示する
            <span className="text-accent font-bold">
              集計には打刻がありますが一覧を取得できませんでした。
              SQL(15_punch_list_rpc.sql)が未実行の可能性があります。
            </span>
          ) : (
            'この日の打刻はありません'
          )}
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
                  <td className="p-2.5 font-bold">{r.staff_name ?? `ID:${r.staff_id}`}</td>
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
                  <td className="p-2.5 font-bold">{r.staff_name ?? `ID:${r.staff_id}`}</td>
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
                    <button
                      onClick={() =>
                        r.freee_error
                          ? alert(`${r.staff_name ?? r.staff_id} さんの打刻\n\n${r.freee_error}`)
                          : undefined
                      }
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
                    </button>
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
      </>
      )}

      <div className="mt-6 p-4 bg-paper2 border-2 border-dashed border-ink">
        <b className="font-mincho block mb-2.5">freee人事労務 連携</b>
        {sync?.configured === false ? (
          <p className="text-sm text-muted">
            未設定です。Vercel の環境変数に FREEE_CLIENT_ID / FREEE_CLIENT_SECRET /
            FREEE_COMPANY_ID / FREEE_INITIAL_REFRESH_TOKEN / SUPABASE_SERVICE_ROLE_KEY
            を設定すると有効になります。
          </p>
        ) : sync?.connected === false ? (
          <>
            <p className="text-sm mb-3">
              環境変数は設定済みですが、まだ freee と接続していません。
              <span className="block text-xs text-muted mt-1">
                下のURLをブラウザで開くと freee の認可画面に進みます。
                {'<CRON_SECRET>'} は Vercel に設定した値に置き換えてください。
              </span>
            </p>
            <code className="block text-xs font-mono bg-paper border-2 border-ink p-2 break-all">
              /api/freee/auth?secret=&lt;CRON_SECRET&gt;
            </code>
            <button
              onClick={loadSyncInfo}
              className="mt-3 px-4 py-2 border-2 border-ink font-mincho font-bold text-sm"
            >
              ↻ 接続状況を確認
            </button>
          </>
        ) : (
          <>
            <p className="text-sm mb-3">
              <span className="inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink bg-accent2 text-paper mr-2">
                接続済
              </span>
              未送信 <b className="font-mono">{sync?.pending ?? '—'}</b> 件 / エラー{' '}
              <b className="font-mono">{sync?.errored ?? '—'}</b> 件
              <span className="block text-xs text-muted mt-1">
                スタッフマスタで freee 従業員ID を設定した人の打刻のみ送信されます。
                「要手動修正」は freee 送信後に直した打刻です。freee 側は手で直してください。
              </span>
            </p>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={runSync}
                disabled={syncing}
                className="px-4 py-2 bg-ink text-paper border-2 border-ink font-mincho font-bold text-sm disabled:bg-stone-400"
              >
                {syncing ? '送信中…' : 'freee に送信'}
              </button>
              <button
                onClick={loadEmployees}
                disabled={empLoading}
                className="px-4 py-2 border-2 border-ink font-mincho font-bold text-sm"
              >
                {empLoading ? '取得中…' : 'freee の従業員IDを確認'}
              </button>
              <button
                onClick={runDiag}
                disabled={diagLoading}
                className="px-4 py-2 border-2 border-ink font-mincho font-bold text-sm"
              >
                {diagLoading ? '診断中…' : '接続を診断'}
              </button>
            </div>
            {diag && (
              <pre className="mt-3 text-[11px] whitespace-pre-wrap font-mono bg-paper border-2 border-ink p-2 max-h-80 overflow-auto">
                {diag}
              </pre>
            )}
            {employees && (
              <div className="mt-3 border-2 border-ink bg-paper">
                <div className="px-3 py-2 bg-ink text-paper font-mincho font-bold text-xs">
                  freee人事労務の従業員
                  <span className="block font-normal opacity-70 mt-0.5">
                    スタッフマスタには「API ID」を入力してください。
                    従業員番号(000015 のようなゼロ埋め)ではありません
                  </span>
                </div>
                {employees.length === 0 ? (
                  <p className="p-3 text-xs text-muted">従業員が取得できませんでした</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] text-muted font-mincho font-bold border-b border-ink">
                        <th className="text-left p-2 w-24">API ID</th>
                        <th className="text-left p-2 w-28">従業員番号</th>
                        <th className="text-left p-2">氏名</th>
                      </tr>
                    </thead>
                    <tbody>
                      {employees.map((e) => (
                        <tr key={e.id} className="border-b border-dotted border-stone-300">
                          <td className="p-2 font-mono font-bold">{e.id}</td>
                          <td className="p-2 font-mono text-muted">{e.num ?? '—'}</td>
                          <td className="p-2 font-bold">{e.name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
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

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

// メンバー1人の1か月。行クリックでその日の編集画面に移る
function MonthView({
  data,
  loading,
  staffSelected,
  onRowClick,
}: {
  data: MonthData | null;
  loading: boolean;
  staffSelected: boolean;
  onRowClick: (d: MonthDay) => void;
}) {
  if (!staffSelected) {
    return (
      <div className="border-2 border-ink p-10 text-center font-mincho text-muted">
        メンバーを選択してください
      </div>
    );
  }
  if (loading) return <div className="p-8 font-mincho">読み込み中…</div>;
  if (!data) {
    return (
      <div className="border-2 border-ink p-10 text-center font-mincho text-muted">
        データを取得できませんでした
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-3 border-2 border-ink mb-4">
        <SummaryCell label="メンバー" value={data.staff_name} hero />
        <SummaryCell label="出勤日数" value={`${data.work_days} 日`} />
        <SummaryCell
          label="合計実働"
          value={`${formatMinutesAsHours(data.total_work_minutes)} h`}
        />
      </div>

      <div className="border-2 border-ink bg-paper overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="bg-ink text-paper">
            <tr>
              <th className="p-2.5 text-left w-28">日付</th>
              <th className="p-2.5 text-center w-20">出勤</th>
              <th className="p-2.5 text-center w-32">休憩入〜戻</th>
              <th className="p-2.5 text-center w-20">退勤</th>
              <th className="p-2.5 text-center w-20">休憩計</th>
              <th className="p-2.5 text-right w-24">実働</th>
              <th className="p-2.5 text-center w-24">状態</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => {
              const wd = new Date(`${d.date}T00:00:00Z`).getUTCDay();
              const weekend = wd === 0 || wd === 6;
              const hasEvents = d.event_count > 0;
              // 出勤しているのに退勤が無い、または打刻が奇数 = 打刻もれの疑い
              const incomplete = hasEvents && (d.end_time === null || d.event_count % 2 === 1);
              return (
                <tr
                  key={d.date}
                  onClick={() => onRowClick(d)}
                  title="クリックでこの日の打刻を編集"
                  className={`border-b border-dotted border-stone-300 cursor-pointer hover:bg-gold/40 ${
                    weekend ? 'bg-paper2' : ''
                  } ${hasEvents ? '' : 'text-stone-400'}`}
                >
                  <td className="p-2 font-mono">
                    {Number(d.date.slice(8, 10))}
                    <span className="text-[10px] text-muted ml-1">({DAY_NAMES[wd]})</span>
                  </td>
                  <td className="p-2 text-center font-mono">{d.start_time ?? '·'}</td>
                  <td className="p-2 text-center font-mono text-xs">
                    <BreakSpans breaks={d.breaks} />
                  </td>
                  <td className="p-2 text-center font-mono">{d.end_time ?? '·'}</td>
                  <td className="p-2 text-center font-mono">
                    {d.break_minutes ? `${d.break_minutes}分` : '·'}
                  </td>
                  <td className="p-2 text-right font-mono font-bold">
                    {d.work_minutes !== null ? `${formatMinutesAsHours(d.work_minutes)}h` : '·'}
                  </td>
                  <td className="p-2 text-center">
                    {incomplete && (
                      <span className="inline-block px-2 py-0.5 text-[10px] font-bold border-1.5 border-ink bg-accent text-paper">
                        打刻もれ
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        行をクリックすると、その日の打刻の編集・追加・削除ができます。
      </p>
    </div>
  );
}

function SummaryCell({ label, value, hero }: { label: string; value: string; hero?: boolean }) {
  return (
    <div
      className={`p-4 border-r-2 border-ink last:border-r-0 ${
        hero ? 'bg-ink text-paper' : 'bg-paper2'
      }`}
    >
      <div
        className={`font-mincho text-[11px] font-bold tracking-widest mb-2 ${
          hero ? 'opacity-70' : 'text-muted'
        }`}
      >
        {label}
      </div>
      <div className={`font-mono text-2xl font-extrabold leading-none ${hero ? 'text-gold' : ''}`}>
        {value}
      </div>
    </div>
  );
}

// 休憩の入り〜戻り。1日に複数回あり得るので全て並べる。
// 戻り打刻が無い場合は「休憩中」と出す
function BreakSpans({ breaks }: { breaks: BreakSpan[] | null | undefined }) {
  if (!breaks || breaks.length === 0) return <span className="text-stone-400">·</span>;
  return (
    <>
      {breaks.map((b, i) => (
        <div key={i} className="whitespace-nowrap">
          {b.begin}〜
          {b.end ?? <span className="text-accent font-bold">休憩中</span>}
        </div>
      ))}
    </>
  );
}
