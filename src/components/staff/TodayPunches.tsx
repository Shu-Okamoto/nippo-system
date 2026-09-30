'use client';

import type { BreakSpan } from '@/lib/types';

/**
 * 当日の打刻内容を本人に見せる。
 *
 * 休憩は分数だけだと「何時に入ったか」が分からず、
 * 休憩戻りを押すときに判断できない。入り/戻りの時刻を並べて出す。
 *
 * 表示する時刻は打刻そのまま。15分丸めは実働の計算だけに使う。
 */
export function TodayPunches({
  clockInAt,
  clockOutAt,
  breakMinutes,
  breaks,
}: {
  clockInAt: string | null;
  clockOutAt: string | null;
  breakMinutes: number | null;
  breaks: BreakSpan[] | null | undefined;
}) {
  const spans = breaks ?? [];

  if (!clockInAt && !clockOutAt && spans.length === 0) {
    return (
      <div className="border-2 border-ink bg-paper2 px-4 py-3 text-center text-sm font-mincho text-muted">
        本日の打刻はまだありません
      </div>
    );
  }

  return (
    <div className="border-2 border-ink bg-paper2 divide-y-2 divide-stone-300">
      <Row label="出勤" value={clockInAt ?? '—'} />

      {spans.length === 0 ? (
        <Row label="休憩" value="—" />
      ) : (
        spans.map((b, i) => (
          <Row
            key={i}
            label={spans.length > 1 ? `休憩${i + 1}` : '休憩'}
            value={
              b.end ? (
                `${b.begin} 〜 ${b.end}`
              ) : (
                <>
                  {b.begin} 〜{' '}
                  <span className="font-mincho font-bold text-accent">休憩中</span>
                </>
              )
            }
          />
        ))
      )}

      <Row
        label="退勤"
        value={clockOutAt ?? '—'}
        note={breakMinutes ? `休憩計 ${breakMinutes}分` : undefined}
      />
    </div>
  );
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="flex items-baseline gap-3 px-4 py-2">
      <span className="font-mincho text-xs font-bold text-muted w-12 shrink-0">{label}</span>
      <span className="font-mono text-base font-extrabold tabular-nums">{value}</span>
      {note && <span className="ml-auto font-mono text-[11px] text-muted">{note}</span>}
    </div>
  );
}

/**
 * 一覧の行に収める1行版。店舗の打刻ボードでメンバーごとに出す。
 * 休憩は直近の1件だけ出す(行が伸びると名前が読みにくくなる)
 */
export function punchSummaryText(m: {
  clock_in_at: string | null;
  clock_out_at: string | null;
  break_minutes: number | null;
  breaks?: BreakSpan[] | null;
}): string {
  const parts: string[] = [];

  if (m.clock_in_at) parts.push(`${m.clock_in_at}〜${m.clock_out_at ?? ''}`);

  const spans = m.breaks ?? [];
  const last = spans[spans.length - 1];
  if (last) {
    parts.push(`休${last.begin}-${last.end ?? '?'}`);
  } else if (m.break_minutes) {
    parts.push(`休${m.break_minutes}分`);
  }

  return parts.join(' ');
}
