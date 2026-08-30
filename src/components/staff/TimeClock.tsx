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

// その状態から押せる打刻
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

export function TimeClock({ slug }: { slug: string }) {
  const [board, setBoard] = useState<ClockBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  // 選択中のメンバー(PIN 入力〜打刻まで)
  const [selected, setSelected] = useState<ClockMember | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  // 他の端末からの打刻も拾えるよう定期的に取り直す。
  // PIN 入力中は画面が切り替わらないよう止める
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && !selected) load();
    }, 30000);
    return () => clearInterval(t);
  }, [load, selected]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // 打刻せずに放置された時に、次の人に画面を渡さないよう自動で戻す
  useEffect(() => {
    if (!selected) return;
    const t = setTimeout(() => closePad(), 60000);
    return () => clearTimeout(t);
  }, [selected]);

  const closePad = () => {
    setSelected(null);
    setPin('');
    setPinError(null);
  };

  const requirePin = board?.require_pin ?? true;

  const punch = async (type: ClockEventType) => {
    if (!selected || busy) return;
    if (requirePin && pin.length < 4) {
      setPinError('PINを4桁以上入力してください');
      return;
    }

    setBusy(true);
    setPinError(null);
    const { data, error: e } = await supabase.rpc('punch_with_pin', {
      p_slug: slug,
      p_staff_id: selected.staff_id,
      p_event_type: type,
      p_pin: requirePin ? pin : null,
    });
    setBusy(false);

    if (e) {
      // PIN 誤りは入力欄だけ消して、その場で入れ直せるようにする
      setPin('');
      setPinError(e.message);
      return;
    }

    const at = (data as any)?.event_time ?? '';
    setToast(`${selected.name} さん ${EVENT_LABEL[type]} ${at}`);
    closePad();
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

      {selected ? (
        <PinPad
          member={selected}
          requirePin={requirePin}
          pin={pin}
          setPin={setPin}
          error={pinError}
          busy={busy}
          onCancel={closePad}
          onPunch={punch}
        />
      ) : (
        <div className="p-5 space-y-3">
          <p className="text-sm font-mincho font-bold text-muted">
            自分の名前を押してください
          </p>
          {board?.members.length === 0 ? (
            <div className="border-2 border-ink p-10 text-center font-mincho text-muted">
              この店舗にスタッフが登録されていません
            </div>
          ) : (
            board?.members.map((m) => (
              <button
                key={m.staff_id}
                onClick={() => {
                  setPin('');
                  setPinError(null);
                  setSelected(m);
                }}
                disabled={requirePin && !m.has_pin}
                className={`w-full border-2 border-ink flex items-center justify-between gap-3 px-4 py-4 text-left ${
                  !requirePin || m.has_pin ? 'bg-paper active:bg-gold' : 'bg-stone-100'
                }`}
              >
                <span className="font-mincho text-lg font-extrabold">
                  {m.name}
                  {requirePin && !m.has_pin && (
                    <span className="ml-2 text-xs font-bold text-accent">PIN未設定</span>
                  )}
                </span>
                <span className="flex items-center gap-2">
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
                </span>
              </button>
            ))
          )}
        </div>
      )}

      <div className="px-5 pb-6 flex items-center justify-between text-xs">
        <Link href={`/store/${slug}/today`} className="font-mincho font-bold text-muted hover:text-ink">
          → 日報入力へ
        </Link>
        <button onClick={() => load()} className="font-mono text-muted hover:text-ink">
          ↻ 最新の状態に更新
        </button>
      </div>

      <p className="px-5 pb-10 text-[11px] text-muted leading-relaxed">
        打刻は勤怠記録として保存されます。日報の「ワークスケジュール(実績)」は
        別管理なので、日報側でもこれまで通り入力してください。
        PINを忘れた場合や誤って押した場合は本部に連絡してください。
      </p>
    </div>
  );
}

// メンバー選択後の PIN 入力 + 打刻
function PinPad({
  member,
  requirePin,
  pin,
  setPin,
  error,
  busy,
  onCancel,
  onPunch,
}: {
  member: ClockMember;
  requirePin: boolean;
  pin: string;
  setPin: (v: string) => void;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onPunch: (t: ClockEventType) => void;
}) {
  const allowed = ALLOWED[member.last_event] ?? [];
  const ready = !requirePin || pin.length >= 4;

  const push = (d: string) => {
    if (pin.length >= PIN_LENGTH_MAX) return;
    setPin(pin + d);
  };

  return (
    <div className="p-5">
      <div className="border-2 border-ink bg-paper">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b-2 border-ink bg-ink text-paper">
          <div className="font-mincho text-lg font-extrabold">{member.name}</div>
          <button
            onClick={onCancel}
            className="text-xs px-3 py-1.5 border-1.5 border-paper font-bold"
          >
            戻る
          </button>
        </div>

        <div className="p-5">
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

          {error && (
            <div className="mb-3 px-3 py-2 border-2 border-accent bg-red-50 text-accent text-sm font-bold text-center">
              {error}
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
              <p className="text-center text-sm font-mincho text-muted py-3">
                本日は退勤済みです。修正が必要な場合は本部に連絡してください。
              </p>
            ) : (
              <>
                <p className="text-xs font-mincho font-bold text-muted mb-2">
                  打刻の種類を押すと記録されます
                </p>
                {/* Tailwind は動的なクラス名を生成できないので固定で分岐する */}
                <div className={`grid gap-2 ${allowed.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                  {allowed.map((type) => (
                    <button
                      key={type}
                      onClick={() => onPunch(type)}
                      disabled={!ready || busy}
                      className={`py-6 border-2 border-ink font-mincho font-extrabold text-base ${
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
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
