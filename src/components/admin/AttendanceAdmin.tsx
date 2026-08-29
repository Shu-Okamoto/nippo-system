'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ClockEventType, Store } from '@/lib/types';

const EVENT_LABEL: Record<ClockEventType, string> = {
  clock_in: '出勤',
  break_begin: '休憩入',
  break_end: '休憩戻',
  clock_out: '退勤',
};

const FREEE_LABEL: Record<string, string> = {
  pending: '未送信',
  sent: '送信済',
  skipped: '対象外',
  error: 'エラー',
};

type EventRow = {
  id: number;
  store_id: number;
  staff_id: number;
  work_date: string;
  event_type: ClockEventType;
  event_at: string;
  is_voided: boolean;
  freee_status: string;
  freee_error: string | null;
  staff: { name: string } | null;
};

type SyncInfo = {
  configured: boolean;
  pending?: number;
  errored?: number;
  message?: string;
};

function jstTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
}

export function AttendanceAdmin() {
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState<number | null>(null);
  const [date, setDate] = useState(() =>
    new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
  );
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncInfo | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: st } = await supabase.from('stores').select('*').order('id');
    const storeList = (st || []) as Store[];
    setStores(storeList);
    const sid = storeId ?? storeList[0]?.id ?? null;
    if (storeId === null && sid !== null) setStoreId(sid);

    if (sid === null) {
      setRows([]);
      setLoading(false);
      return;
    }

    const { data, error: e } = await supabase
      .from('time_clock_events')
      .select('*, staff(name)')
      .eq('store_id', sid)
      .eq('work_date', date)
      .order('event_at');

    if (e) setError(e.message);
    else {
      setError(null);
      setRows((data || []) as EventRow[]);
    }
    setLoading(false);
  }, [storeId, date]);

  useEffect(() => {
    load();
  }, [load]);

  // freee 連携の設定状況と未送信件数
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

  const voidEvent = async (r: EventRow) => {
    const label = `${r.staff?.name ?? r.staff_id} さんの ${EVENT_LABEL[r.event_type]} ${jstTime(r.event_at)}`;
    if (!confirm(`${label} を取り消します。\n実績シフトも打刻し直しの状態に戻ります。よろしいですか?`)) {
      return;
    }
    const { error: e } = await supabase.rpc('void_punch', { p_event_id: r.id });
    if (e) {
      alert(`取り消せませんでした: ${e.message}`);
      return;
    }
    load();
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
      if (j.error) {
        setSyncResult(`エラー: ${j.error}`);
      } else if (j.configured === false) {
        setSyncResult(j.message || 'freee 連携は未設定です');
      } else {
        setSyncResult(
          `送信 ${j.sent} 件 / 対象外 ${j.skipped} 件 / 失敗 ${j.failed} 件` +
            (j.errors?.length ? `\n${j.errors.join('\n')}` : '')
        );
      }
    } catch (err: any) {
      setSyncResult(`エラー: ${err.message}`);
    }
    setSyncing(false);
    loadSyncInfo();
    load();
  };

  return (
    <div>
      <div className="flex flex-wrap gap-3 items-center mb-4">
        <div className="flex border-2 border-ink">
          {stores.map((s) => (
            <button
              key={s.id}
              onClick={() => setStoreId(s.id)}
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
          onChange={(e) => setDate(e.target.value)}
          className="border-2 border-ink p-2 font-mono"
        />
        <button onClick={load} className="px-3 py-2 border-2 border-ink font-bold text-sm">
          ↻ 更新
        </button>
      </div>

      {error && <div className="mb-3 text-sm text-accent font-bold">⚠ {error}</div>}

      {loading ? (
        <div className="p-8 font-mincho">読み込み中…</div>
      ) : rows.length === 0 ? (
        <div className="border-2 border-ink p-10 text-center font-mincho text-muted">
          この日の打刻はありません
        </div>
      ) : (
        <table className="w-full border-2 border-ink bg-paper text-sm">
          <thead className="bg-ink text-paper">
            <tr>
              <th className="p-2.5 text-left w-20">時刻</th>
              <th className="p-2.5 text-left">メンバー</th>
              <th className="p-2.5 text-left w-24">打刻</th>
              <th className="p-2.5 text-left w-28">freee</th>
              <th className="p-2.5 text-center w-24">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-ink ${r.is_voided ? 'text-stone-400 line-through' : ''}`}
              >
                <td className="p-2.5 font-mono">{jstTime(r.event_at)}</td>
                <td className="p-2.5 font-bold">{r.staff?.name ?? `ID:${r.staff_id}`}</td>
                <td className="p-2.5">
                  <span className="inline-block px-2 py-0.5 text-xs font-bold border-1.5 border-ink bg-paper2">
                    {EVENT_LABEL[r.event_type]}
                  </span>
                </td>
                <td className="p-2.5 text-xs">
                  <span
                    className={`inline-block px-2 py-0.5 font-bold border-1.5 border-ink ${
                      r.freee_status === 'sent'
                        ? 'bg-accent2 text-paper'
                        : r.freee_status === 'error'
                        ? 'bg-accent text-paper'
                        : 'bg-paper2'
                    }`}
                    title={r.freee_error || ''}
                  >
                    {FREEE_LABEL[r.freee_status] ?? r.freee_status}
                  </span>
                </td>
                <td className="p-2.5 text-center">
                  {!r.is_voided && (
                    <button
                      onClick={() => voidEvent(r)}
                      className="text-xs px-2.5 py-1 border-1.5 border-accent text-paper bg-accent font-bold"
                    >
                      取消
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
