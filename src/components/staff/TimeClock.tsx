'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import type { ClockBoard, ClockEventType, ClockMember, ClockState } from '@/lib/types';

const EVENT_LABEL: Record<ClockEventType, string> = {
  clock_in: '出勤',
  break_begin: '休憩入',
  break_end: '休憩戻',
  clock_out: '退勤',
};

const STATE_LABEL: Record<ClockState, string> = {
  none: '未出勤',
  clock_in: '勤務中',
  break_begin: '休憩中',
  break_end: '勤務中',
  clock_out: '退勤済',
};

// その状態から押せる打刻。ここに無いボタンは非活性で表示する
const ALLOWED: Record<ClockState, ClockEventType[]> = {
  none: ['clock_in'],
  clock_in: ['break_begin', 'clock_out'],
  break_begin: ['break_end'],
  break_end: ['break_begin', 'clock_out'],
  clock_out: [],
};

const BUTTONS: ClockEventType[] = ['clock_in', 'break_begin', 'break_end', 'clock_out'];

function stateStyle(s: ClockState): string {
  switch (s) {
    case 'clock_in':
    case 'break_end':
      return 'bg-accent2 text-paper';
    case 'break_begin':
      return 'bg-gold';
    case 'clock_out':
      return 'bg-stone-300';
    default:
      return 'bg-paper2';
  }
}

export function TimeClock({ slug }: { slug: string }) {
  const [board, setBoard] = useState<ClockBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.rpc('get_clock_board', { p_slug: slug });
    if (e) {
      setError(e.message);
    } else {
      setError(null);
      setBoard(data as ClockBoard);
    }
    setLoading(false);
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  // 時計。SSR とクライアントで時刻がずれるのでマウント後に開始する
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // 他の端末からの打刻も拾えるよう定期的に取り直す
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 30000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const punch = async (m: ClockMember, type: ClockEventType) => {
    if (pending !== null) return;
    if (!confirm(`${m.name} さんの「${EVENT_LABEL[type]}」を記録します。よろしいですか?`)) return;

    setPending(m.staff_id);
    setError(null);
    const { data, error: e } = await supabase.rpc('punch', {
      p_slug: slug,
      p_staff_id: m.staff_id,
      p_event_type: type,
    });
    setPending(null);

    if (e) {
      setError(`${m.name}: ${e.message}`);
      // 別端末で先に打刻された可能性があるので状態を取り直す
      load();
      return;
    }
    const at = (data as any)?.event_time ?? '';
    setToast(`${m.name} さん ${EVENT_LABEL[type]} ${at}`);
    await load();
  };

  if (loading) return <div className="p-8 text-center font-mincho">読み込み中…</div>;
  if (error && !board) {
    return <div className="p-8 text-center text-accent font-bold">{error}</div>;
  }

  const timeStr = now
    ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    : '--:--:--';

  return (
    <div className="max-w-2xl mx-auto bg-paper min-h-screen pb-10">
      <div className="sticky top-0 z-10 px-5 py-4 border-b-2 border-ink bg-paper">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mincho text-xl font-extrabold leading-none">
              {board?.store_name}
              <span className="ml-2 text-xs font-bold text-accent">勤怠打刻</span>
            </div>
            <div className="font-mono text-xs text-muted mt-1 tracking-wider">{board?.today}</div>
          </div>
          <div className="font-mono text-3xl font-extrabold leading-none tabular-nums">
            {timeStr}
          </div>
        </div>
        {error && <div className="mt-2 text-xs text-accent font-bold">⚠ {error}</div>}
      </div>

      {toast && (
        <div className="mx-5 mt-4 px-4 py-3 border-2 border-ink bg-accent2 text-paper font-mincho font-bold text-center">
          ✓ {toast}
        </div>
      )}

      <div className="p-5 space-y-4">
        {board?.members.length === 0 ? (
          <div className="border-2 border-ink p-10 text-center font-mincho text-muted">
            この店舗にスタッフが登録されていません
          </div>
        ) : (
          board?.members.map((m) => {
            const allowed = ALLOWED[m.last_event] ?? [];
            const busy = pending === m.staff_id;
            return (
              <div key={m.staff_id} className="border-2 border-ink bg-paper">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b-2 border-ink">
                  <div className="font-mincho text-lg font-extrabold">{m.name}</div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted">
                      {m.clock_in_at ? `${m.clock_in_at}〜` : ''}
                      {m.clock_out_at ?? ''}
                      {m.break_minutes ? ` 休${m.break_minutes}分` : ''}
                    </span>
                    <span
                      className={`px-2 py-0.5 text-xs font-bold border-1.5 border-ink ${stateStyle(
                        m.last_event
                      )}`}
                    >
                      {STATE_LABEL[m.last_event]}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-4">
                  {BUTTONS.map((type) => {
                    const on = allowed.includes(type);
                    return (
                      <button
                        key={type}
                        onClick={() => punch(m, type)}
                        disabled={!on || busy || pending !== null}
                        className={`py-5 font-mincho font-extrabold text-sm border-r-2 border-ink last:border-r-0 transition-colors ${
                          on
                            ? type === 'clock_out'
                              ? 'bg-accent text-paper active:bg-ink'
                              : 'bg-ink text-paper active:bg-accent2'
                            : 'bg-stone-100 text-stone-300'
                        }`}
                      >
                        {busy ? '…' : EVENT_LABEL[type]}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-5 pb-6 flex items-center justify-between text-xs">
        <Link href={`/store/${slug}/today`} className="font-mincho font-bold text-muted hover:text-ink">
          → 日報入力へ
        </Link>
        <button onClick={() => load()} className="font-mono text-muted hover:text-ink">
          ↻ 最新の状態に更新
        </button>
      </div>

      <p className="px-5 pb-10 text-[11px] text-muted leading-relaxed">
        打刻はそのまま日報の「ワークスケジュール(実績)」に反映されます。
        誤って押した場合は本部の管理画面から取り消してください。
      </p>
    </div>
  );
}
