'use client';
import type { ShiftEntry, ShiftPattern } from '@/lib/types';
import { TimeInput } from './TimeInput';
import { PATTERN_LABEL, getPatternTimes, shiftMinutes } from '@/lib/calc';

export function ShiftEditor({
  entry,
  staffName,
  onChange,
}: {
  entry: ShiftEntry;
  staffName: string;
  onChange: (patch: Partial<ShiftEntry>) => void;
}) {
  const isPlan = entry.entry_type === 'plan';
  const isThrough = isPlan && entry.pattern === 'through';
  const showBreak = !isPlan;
  const hours = (shiftMinutes(entry) / 60).toFixed(1);

  return (
    <div className="mt-3 p-3 bg-paper2 border-2 border-ink">
      <div className="flex items-center justify-between mb-3">
        <b className="font-mincho text-sm">{staffName} の{isPlan ? '予定' : '実績'}</b>
        <span className="font-mono text-xs text-muted">実労 {hours}h</span>
      </div>

      {isPlan ? (
        <>
          <div className="grid grid-cols-3 gap-1.5 mb-2">
            {(['first', 'last', 'through'] as ShiftPattern[]).map((p) => {
              const pt = getPatternTimes(p);
              return (
                <button
                  key={p}
                  onClick={() => onChange({ pattern: p, break_minutes: pt.defaultBreak })}
                  className={`py-2 px-1 border-2 border-ink font-mincho text-xs font-bold leading-tight ${
                    entry.pattern === p ? 'bg-ink text-paper' : 'bg-paper hover:bg-paper2'
                  }`}
                >
                  {PATTERN_LABEL[p]}
                  <small className={`block font-mono font-medium text-[9px] mt-0.5 ${
                    entry.pattern === p ? 'opacity-70' : 'text-muted'
                  }`}>
                    {pt.start.slice(0,5)}-{pt.end.slice(0,5)}
                  </small>
                </button>
              );
            })}
          </div>

          {isThrough && (
            <div className="mt-2 p-2.5 bg-yellow-50 border-2 border-dashed border-ink">
              <b className="font-mincho text-xs block mb-1.5">休憩時間</b>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="number"
                  inputMode="numeric"
                  value={entry.break_minutes || 60}
                  onChange={(e) => onChange({ break_minutes: Number(e.target.value) || 0 })}
                  className="w-16 p-2 font-mono text-base font-bold text-center border-2 border-ink bg-paper"
                />
                <span className="text-xs font-bold text-muted">分</span>
                <span className="ml-auto font-mono text-[11px] text-muted whitespace-nowrap">
                  → 実労 {hours}h
                </span>
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <TimeInput
              value={entry.start_time}
              onChange={(v) => onChange({ start_time: v })}
              placeholder="9:00"
              className="flex-1 min-w-0"
            />
            <span className="font-mono font-extrabold">─</span>
            <TimeInput
              value={entry.end_time}
              onChange={(v) => onChange({ end_time: v })}
              placeholder="17:00"
              className="flex-1 min-w-0"
            />
          </div>

          {showBreak && (
            <div className="mt-2 p-2.5 bg-yellow-50 border-2 border-dashed border-ink">
              <b className="font-mincho text-xs block mb-2">休憩(任意)</b>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-2 items-center">
                <span className="text-xs font-bold text-muted">休憩入</span>
                <TimeInput
                  value={entry.break_start}
                  onChange={(v) => onChange({ break_start: v })}
                  placeholder="13:00"
                  className="w-full"
                />
                <span className="text-xs font-bold text-muted">休憩出</span>
                <TimeInput
                  value={entry.break_end}
                  onChange={(v) => onChange({ break_end: v })}
                  placeholder="14:00"
                  className="w-full"
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
