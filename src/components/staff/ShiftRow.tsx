'use client';
import type { ShiftEntry } from '@/lib/types';
import { shiftMinutes, formatTimeRange, getPatternTimes } from '@/lib/calc';

// 9:00を0%, 17:00を100%とする(8時間スパン)
const SPAN_START = 9 * 60;
const SPAN_END = 17 * 60;
const SPAN = SPAN_END - SPAN_START;

function timeToPct(t: string | null): number {
  if (!t) return 0;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 0;
  const min = Number(m[1]) * 60 + Number(m[2]);
  return Math.max(0, Math.min(100, ((min - SPAN_START) / SPAN) * 100));
}

export function ShiftRow({
  entry,
  staffName,
  selected,
  onSelect,
  onDelete,
}: {
  entry: ShiftEntry;
  staffName: string;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  let start: string | null = entry.start_time;
  let end: string | null = entry.end_time;
  if (entry.entry_type === 'plan' && entry.pattern) {
    const p = getPatternTimes(entry.pattern);
    start = p.start;
    end = p.end;
  }
  const left = timeToPct(start);
  const width = Math.max(0, timeToPct(end) - left);
  const minutes = shiftMinutes(entry);
  const hours = (minutes / 60).toFixed(1);
  const isPlan = entry.entry_type === 'plan';

  return (
    <div
      className={`grid grid-cols-[90px_1fr_50px] border-b border-ink last:border-b-0 cursor-pointer ${
        selected ? 'bg-yellow-50' : ''
      }`}
      onClick={onSelect}
    >
      <div className="px-2 py-2.5 text-xs font-semibold border-r border-ink bg-paper2 flex items-center justify-between">
        <span className="truncate">{staffName}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-accent text-base font-bold px-1"
          title="削除"
        >
          ×
        </button>
      </div>
      <div className="relative h-11 border-r border-ink"
        style={{ background: 'repeating-linear-gradient(90deg, transparent 0, transparent calc(12.5% - 1px), rgba(26,24,20,.15) calc(12.5% - 1px), rgba(26,24,20,.15) 12.5%)' }}
      >
        {width > 0 && (
          <div
            className={`absolute top-1.5 bottom-1.5 flex items-center justify-center text-[10px] font-mono font-bold ${
              isPlan ? 'bg-paper border-2 border-dashed border-ink text-ink' : 'bg-ink text-paper'
            }`}
            style={{ left: `${left}%`, width: `${width}%` }}
          >
            <span className="px-1 truncate">{formatTimeRange(entry)}</span>
          </div>
        )}
      </div>
      <div className="px-1 py-2.5 font-mono text-sm font-extrabold text-center flex items-center justify-center bg-paper">
        {hours}
      </div>
    </div>
  );
}
