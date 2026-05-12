import type { ShiftEntry, ShiftPattern } from './types';

const PATTERN_TIMES: Record<ShiftPattern, { start: string; end: string; defaultBreak: number }> = {
  first:   { start: '09:00', end: '13:00', defaultBreak: 0 },
  last:    { start: '13:00', end: '17:00', defaultBreak: 0 },
  through: { start: '09:00', end: '17:00', defaultBreak: 60 },
};

export const PATTERN_LABEL: Record<ShiftPattern, string> = {
  first: '前半',
  last: '後半',
  through: '通し',
};

export function getPatternTimes(p: ShiftPattern) {
  return PATTERN_TIMES[p];
}

function parseHM(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (isNaN(h) || isNaN(min) || h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function shiftMinutes(s: ShiftEntry): number {
  let startMin: number | null = null;
  let endMin: number | null = null;
  let breakMin = 0;

  if (s.entry_type === 'plan' && s.pattern) {
    const p = PATTERN_TIMES[s.pattern];
    startMin = parseHM(p.start);
    endMin = parseHM(p.end);
    breakMin = s.break_minutes ?? p.defaultBreak;
  } else {
    startMin = parseHM(s.start_time);
    endMin = parseHM(s.end_time);
    const bs = parseHM(s.break_start);
    const be = parseHM(s.break_end);
    if (bs !== null && be !== null && be > bs) {
      breakMin = be - bs;
    } else {
      breakMin = s.break_minutes ?? 0;
    }
  }

  if (startMin === null || endMin === null || endMin <= startMin) return 0;
  return Math.max(0, endMin - startMin - breakMin);
}

export function totalHours(shifts: ShiftEntry[]): number {
  const total = shifts
    .filter((s) => s.entry_type === 'actual')
    .reduce((sum, s) => sum + shiftMinutes(s), 0);
  return total / 60;
}

export function ninjibai(salesActual: number | null, totalH: number): number | null {
  if (!salesActual || totalH <= 0) return null;
  return Math.round(salesActual / totalH);
}

export function kyakuTanka(salesActual: number | null, customerCount: number | null): number | null {
  if (!salesActual || !customerCount) return null;
  return Math.round(salesActual / customerCount);
}

export function formatJpy(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return '¥' + n.toLocaleString('ja-JP');
}

export function formatHours(h: number): string {
  return h.toFixed(1);
}

export function formatTimeRange(s: ShiftEntry): string {
  if (s.entry_type === 'plan' && s.pattern) {
    const p = PATTERN_TIMES[s.pattern];
    if (s.pattern === 'through') {
      return `${p.start} - ${p.end} (休${s.break_minutes ?? p.defaultBreak})`;
    }
    return `${p.start} - ${p.end}`;
  }
  if (s.start_time && s.end_time) {
    const base = `${s.start_time.slice(0,5)} - ${s.end_time.slice(0,5)}`;
    if (s.break_start && s.break_end) {
      return `${base} (休${s.break_start.slice(0,5)}-${s.break_end.slice(0,5)})`;
    }
    if (s.break_minutes > 0) return `${base} (休${s.break_minutes}分)`;
    return base;
  }
  return '—';
}

export function staffDisplayName(s: ShiftEntry, staffName?: string): string {
  if (staffName) return staffName;
  return s.staff_name_manual || '(未設定)';
}
