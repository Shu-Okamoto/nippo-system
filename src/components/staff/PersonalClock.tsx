'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { ClockEventType, ClockState, PersonalClockBoard } from '@/lib/types';

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

const ALLOWED: Record<ClockState, ClockEventType[]> = {
  none: ['clock_in'],
  clock_in: ['break_begin', 'clock_out'],
  break_begin: ['break_end'],
  break_end: ['break_begin', 'clock_out'],
  clock_out: [],
};

const PIN_LENGTH_MAX = 6;

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

export function PersonalClock({ token }: { token: string }) {
  const [board, setBoard] = useState<PersonalClockBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('get_personal_clock', { p_token: token });
    if (error) {
      setFatal(error.message);
    } else {
      setFatal(null);
      setBoard(data as PersonalClockBoard);
    }
    setLoading(false);
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const requirePin = board?.require_pin ?? true;

  const punch = async (type: ClockEventType) => {
    if (busy || !board) return;
    if (requirePin && pin.length < 4) {
      setPinError('PINを4桁以上入力してください');
      return;
    }

    setBusy(true);
    setPinError(null);
    const { data, error } = await supabase.rpc('punch_by_token', {
      p_token: token,
      p_event_type: type,
      p_pin: requirePin ? pin : null,
    });
    setBusy(false);

    if (error) {
      setPin('');
      setPinError(error.message);
      return;
    }

    const at = (data as any)?.event_time ?? '';
    setToast(`${EVENT_LABEL[type]} ${at} を記録しました`);
    setPin('');
    await load();
  };

  if (loading) return <div className="p-8 text-center font-mincho">読み込み中…</div>;

  if (fatal || !board) {
    return (
      <div className="max-w-md mx-auto min-h-screen bg-paper p-8">
        <div className="border-2 border-accent bg-red-50 p-6 text-center">
          <div className="font-mincho text-lg font-extrabold text-accent mb-2">
            打刻できません
          </div>
          <p className="text-sm">{fatal ?? '打刻情報を取得できませんでした'}</p>
        </div>
      </div>
    );
  }

  const allowed = ALLOWED[board.last_event] ?? [];
  const ready = !requirePin || pin.length >= 4;
  const timeStr = now
    ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
    : '--:--:--';

  const push = (d: string) => {
    if (pin.length >= PIN_LENGTH_MAX) return;
    setPin(pin + d);
  };

  return (
    <div className="max-w-md mx-auto bg-paper min-h-screen pb-10">
      <div className="px-5 py-4 border-b-2 border-ink bg-paper">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-xs text-muted tracking-wider">
              {board.store_name} · {board.today}
            </div>
            <div className="font-mincho text-2xl font-extrabold leading-tight mt-1">
              {board.name}
            </div>
          </div>
          <div className="font-mono text-2xl font-extrabold leading-none tabular-nums">
            {timeStr}
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <span
            className={`px-2.5 py-1 text-xs font-bold border-1.5 border-ink ${stateStyle(
              board.last_event
            )}`}
          >
            {STATE_LABEL[board.last_event]}
          </span>
          <span className="font-mono text-xs text-muted">
            {board.clock_in_at ? `${board.clock_in_at}〜` : ''}
            {board.clock_out_at ?? ''}
            {board.break_minutes ? ` 休${board.break_minutes}分` : ''}
          </span>
        </div>
      </div>

      {toast && (
        <div className="mx-5 mt-4 px-4 py-3 border-2 border-ink bg-accent2 text-paper font-mincho font-bold text-center">
          ✓ {toast}
        </div>
      )}

      <div className="p-5">
        {requirePin && !board.has_pin ? (
          <div className="border-2 border-accent bg-red-50 p-5 text-center">
            <p className="font-mincho font-bold text-accent mb-1">PINが未設定です</p>
            <p className="text-sm">本部にPINの発行を依頼してください。</p>
          </div>
        ) : (
          <>
            {requirePin && (
              <>
                <p className="text-sm font-mincho font-bold mb-3">PINを入力してください</p>

                <div className="flex items-center justify-center gap-2 mb-4 h-12">
                  {Array.from({ length: PIN_LENGTH_MAX }).map((_, i) => (
                    <span
                      key={i}
                      className={`w-8 h-11 border-2 border-ink flex items-center justify-center font-mono text-2xl font-extrabold ${
                        i < pin.length ? 'bg-ink text-paper' : 'bg-paper2 text-stone-300'
                      }`}
                    >
                      {i < pin.length ? '●' : ''}
                    </span>
                  ))}
                </div>
              </>
            )}

            {pinError && (
              <div className="mb-3 px-3 py-2 border-2 border-accent bg-red-50 text-accent text-sm font-bold text-center">
                {pinError}
              </div>
            )}

            {requirePin && (
              <div className="grid grid-cols-3 gap-2 mb-5">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                  <button
                    key={d}
                    onClick={() => push(d)}
                    disabled={busy}
                    className="py-5 border-2 border-ink bg-paper font-mono text-2xl font-extrabold active:bg-gold"
                  >
                    {d}
                  </button>
                ))}
                <button
                  onClick={() => setPin('')}
                  disabled={busy}
                  className="py-5 border-2 border-ink bg-paper2 font-mincho text-sm font-bold active:bg-gold"
                >
                  クリア
                </button>
                <button
                  onClick={() => push('0')}
                  disabled={busy}
                  className="py-5 border-2 border-ink bg-paper font-mono text-2xl font-extrabold active:bg-gold"
                >
                  0
                </button>
                <button
                  onClick={() => setPin(pin.slice(0, -1))}
                  disabled={busy}
                  className="py-5 border-2 border-ink bg-paper2 font-mincho text-sm font-bold active:bg-gold"
                >
                  ← 削除
                </button>
              </div>
            )}

            <div className={requirePin ? 'border-t-2 border-ink pt-4' : ''}>
              {allowed.length === 0 ? (
                <p className="text-center text-sm font-mincho text-muted py-4">
                  本日は退勤済みです。修正が必要な場合は本部に連絡してください。
                </p>
              ) : (
                <div
                  className={`grid gap-2 ${allowed.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}
                >
                  {allowed.map((type) => (
                    <button
                      key={type}
                      onClick={() => punch(type)}
                      disabled={!ready || busy}
                      className={`py-7 border-2 border-ink font-mincho font-extrabold text-lg ${
                        !ready || busy
                          ? 'bg-stone-100 text-stone-300'
                          : type === 'clock_out'
                          ? 'bg-accent text-paper active:bg-ink'
                          : 'bg-ink text-paper active:bg-accent2'
                      }`}
                    >
                      {busy ? '…' : EVENT_LABEL[type]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <button
          onClick={() => load()}
          className="mt-5 w-full py-2 font-mono text-xs text-muted hover:text-ink"
        >
          ↻ 最新の状態に更新
        </button>
      </div>

      <p className="px-5 pb-10 text-[11px] text-muted leading-relaxed">
        このURLはあなた専用です。他の人に転送しないでください。
        打刻の修正が必要な場合は本部に連絡してください。
      </p>
    </div>
  );
}
