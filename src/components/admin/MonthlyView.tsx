'use client';

import { useEffect, useState, useCallback, Fragment } from 'react';
import { supabase } from '@/lib/supabase';
import type { Store, Staff, ShiftEntry, EntryType } from '@/lib/types';
import { shiftMinutes, formatJpy } from '@/lib/calc';

type SalesRow = {
  date: string;
  day: number;
  dayName: string;
  isWeekend: boolean;
  perStore: Record<number, { sales: number | null; hours: number; ninjibai: number | null }>;
  totalSales: number | null;
  totalHours: number;
  avgNinjibai: number | null;
};

type ShiftCell = Record<string, number>;

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function monthRange(month: string): { start: string; end: string; days: string[] } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const days: string[] = [];
  for (let d = 1; d <= last; d++) {
    days.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  return { start: days[0], end: days[days.length - 1], days };
}

export function MonthlyView() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [stores, setStores] = useState<Store[]>([]);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [salesRows, setSalesRows] = useState<SalesRow[]>([]);
  const [shiftMap, setShiftMap] = useState<Record<EntryType, ShiftCell>>({
    plan: {},
    actual: {},
  });
  const [shiftStoreId, setShiftStoreId] = useState<number | null>(null);
  const [shiftTab, setShiftTab] = useState<EntryType>('actual');
  const [loading, setLoading] = useState(true);

  const { days } = monthRange(month);

  const load = useCallback(async () => {
    setLoading(true);
    const { start, end, days: dayList } = monthRange(month);

    const { data: storeData } = await supabase
      .from('stores')
      .select('*')
      .eq('is_active', true)
      .order('id');
    const storeList = (storeData || []) as Store[];
    setStores(storeList);
    setShiftStoreId((prev) => prev ?? storeList[0]?.id ?? null);

    const { data: staffData } = await supabase
      .from('staff')
      .select('*')
      .eq('is_active', true)
      .order('sort_order');
    setStaffList((staffData || []) as Staff[]);

    const { data: kpi } = await supabase
      .from('daily_kpi')
      .select('*')
      .gte('report_date', start)
      .lte('report_date', end);

    const { data: reports } = await supabase
      .from('daily_reports')
      .select('id, report_date, store_id')
      .gte('report_date', start)
      .lte('report_date', end);

    const reportIds = (reports || []).map((r) => r.id);
    const { data: shiftRows } = reportIds.length
      ? await supabase
          .from('shift_entries')
          .select('*')
          .in('daily_report_id', reportIds)
      : { data: [] };

    // 日報id → (日付, 店舗) の逆引き
    const reportMeta = new Map<number, { date: string; storeId: number }>();
    for (const r of (reports || []) as any[]) {
      reportMeta.set(r.id, { date: r.report_date, storeId: r.store_id });
    }

    // シフト集計: `${storeId}|${staffKey}|${date}` → 時間数
    const nextShiftMap: Record<EntryType, ShiftCell> = { plan: {}, actual: {} };
    for (const sh of (shiftRows || []) as ShiftEntry[]) {
      const meta = reportMeta.get(sh.daily_report_id);
      if (!meta) continue;
      const staffKey = sh.staff_id !== null ? `s${sh.staff_id}` : `m${sh.staff_name_manual || ''}`;
      const key = `${meta.storeId}|${staffKey}|${meta.date}`;
      const hours = shiftMinutes(sh) / 60;
      const bucket = nextShiftMap[sh.entry_type];
      bucket[key] = (bucket[key] || 0) + hours;
    }
    setShiftMap(nextShiftMap);

    // 売上テーブル: 日付 × 店舗
    const kpiByKey = new Map<string, any>();
    for (const k of (kpi || []) as any[]) {
      kpiByKey.set(`${k.store_id}|${k.report_date}`, k);
    }

    const rows: SalesRow[] = dayList.map((date) => {
      const d = new Date(date);
      const perStore: SalesRow['perStore'] = {};
      let totalSales = 0;
      let totalHours = 0;
      let hasAny = false;

      for (const st of storeList) {
        const k = kpiByKey.get(`${st.id}|${date}`);
        const sales = k?.sales_actual ?? null;
        const hours = Number(k?.total_hours || 0);
        perStore[st.id] = {
          sales,
          hours,
          ninjibai: sales !== null && hours > 0 ? Math.round(sales / hours) : null,
        };
        if (sales !== null) {
          totalSales += sales;
          hasAny = true;
        }
        totalHours += hours;
      }

      return {
        date,
        day: d.getDate(),
        dayName: DAY_NAMES[d.getDay()],
        isWeekend: d.getDay() === 0 || d.getDay() === 6,
        perStore,
        totalSales: hasAny ? totalSales : null,
        totalHours,
        avgNinjibai: hasAny && totalHours > 0 ? Math.round(totalSales / totalHours) : null,
      };
    });
    setSalesRows(rows);
    setLoading(false);
  }, [month]);

  useEffect(() => {
    load();
  }, [load]);

  // 月合計
  const monthTotals = stores.reduce(
    (acc, st) => {
      let sales = 0;
      let hours = 0;
      let has = false;
      for (const r of salesRows) {
        const c = r.perStore[st.id];
        if (!c) continue;
        if (c.sales !== null) {
          sales += c.sales;
          has = true;
        }
        hours += c.hours;
      }
      acc[st.id] = {
        sales: has ? sales : null,
        hours,
        ninjibai: has && hours > 0 ? Math.round(sales / hours) : null,
      };
      return acc;
    },
    {} as Record<number, { sales: number | null; hours: number; ninjibai: number | null }>
  );

  const grandSales = salesRows.reduce((s, r) => s + (r.totalSales || 0), 0);
  const grandHours = salesRows.reduce((s, r) => s + r.totalHours, 0);
  const grandNinjibai = grandHours > 0 ? Math.round(grandSales / grandHours) : null;

  // シフト表の行(選択店舗のスタッフ + 手入力名)
  const shiftRowsForStore = (() => {
    if (shiftStoreId === null) return [];
    const bucket = shiftMap[shiftTab];
    const masters = staffList
      .filter((s) => s.store_id === shiftStoreId)
      .map((s) => ({ key: `s${s.id}`, name: s.name, sort: s.sort_order }));

    // マスタに無い手入力メンバーを拾う
    const manualKeys = new Set<string>();
    for (const k of Object.keys(bucket)) {
      const [storeIdStr, staffKey] = k.split('|');
      if (Number(storeIdStr) !== shiftStoreId) continue;
      if (staffKey.startsWith('m')) manualKeys.add(staffKey);
    }
    const manuals = Array.from(manualKeys).map((k) => ({
      key: k,
      name: k.slice(1) || '(未設定)',
      sort: 9999,
    }));

    return [...masters, ...manuals]
      .map((m) => {
        const cells = days.map((date) => bucket[`${shiftStoreId}|${m.key}|${date}`] || 0);
        return { ...m, cells, total: cells.reduce((a, b) => a + b, 0) };
      })
      .filter((m) => m.total > 0 || m.key.startsWith('s'))
      .sort((a, b) => a.sort - b.sort);
  })();

  const shiftDayTotals = days.map((_, i) =>
    shiftRowsForStore.reduce((sum, r) => sum + r.cells[i], 0)
  );
  const shiftGrandTotal = shiftDayTotals.reduce((a, b) => a + b, 0);

  return (
    <div className="p-6 max-w-[1600px] mx-auto print-area">
      <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div>
          <h1 className="font-mincho text-3xl font-extrabold">月間レポート</h1>
          <p className="text-xs text-muted font-mono mt-1 tracking-wider">MONTHLY · {month}</p>
        </div>
        <div className="flex gap-2 items-center no-print">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="border-2 border-ink p-2 font-mono"
          />
          <button
            onClick={() => window.print()}
            className="px-5 py-3 bg-ink text-paper border-2 border-ink font-mincho font-extrabold shadow-inkSm hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-ink transition-all"
          >
            🖨 印刷
          </button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center font-mincho">読み込み中…</div>
      ) : (
        <>
          {/* ===== 売上・人時売 ===== */}
          <h2 className="font-mincho text-xl font-extrabold mb-3 flex items-center gap-2 before:content-[''] before:w-4 before:h-0.5 before:bg-ink">
            売上・人時売
          </h2>
          <div className="border-2 border-ink bg-paper mb-8 overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[720px]">
              <thead>
                <tr className="bg-ink text-paper font-mincho text-xs">
                  <th rowSpan={2} className="p-2 border-r border-paper/30 sticky left-0 bg-ink z-10 w-16">
                    日付
                  </th>
                  {stores.map((st) => (
                    <th key={st.id} colSpan={2} className="p-2 border-r border-paper/30 text-center">
                      {st.name}
                    </th>
                  ))}
                  <th colSpan={2} className="p-2 text-center bg-accent">
                    合計
                  </th>
                </tr>
                <tr className="bg-ink text-paper font-mincho text-[10px]">
                  {stores.map((st) => (
                    <Fragment key={st.id}>
                      <th className="p-1.5 border-r border-paper/20 font-normal">売上</th>
                      <th className="p-1.5 border-r border-paper/30 font-normal">人時売</th>
                    </Fragment>
                  ))}
                  <th className="p-1.5 border-r border-paper/20 bg-accent font-normal">売上</th>
                  <th className="p-1.5 bg-accent font-normal">平均人時売</th>
                </tr>
              </thead>
              <tbody>
                {salesRows.map((r) => (
                  <tr
                    key={r.date}
                    className={`border-b border-dotted border-stone-300 ${
                      r.isWeekend ? 'bg-paper2' : ''
                    }`}
                  >
                    <td
                      className={`p-1.5 px-2 font-mono text-xs border-r border-ink sticky left-0 z-10 ${
                        r.isWeekend ? 'bg-paper2' : 'bg-paper'
                      }`}
                    >
                      {r.day}
                      <span className="text-[10px] text-muted ml-1">({r.dayName})</span>
                    </td>
                    {stores.map((st) => {
                      const c = r.perStore[st.id];
                      return (
                        <Fragment key={st.id}>
                          <td className="p-1.5 font-mono text-right text-xs">
                            {c?.sales !== null && c?.sales !== undefined
                              ? c.sales.toLocaleString('ja-JP')
                              : '—'}
                          </td>
                          <td className="p-1.5 font-mono text-right text-xs border-r border-ink">
                            {c?.ninjibai !== null && c?.ninjibai !== undefined
                              ? c.ninjibai.toLocaleString('ja-JP')
                              : '—'}
                          </td>
                        </Fragment>
                      );
                    })}
                    <td className="p-1.5 font-mono text-right text-xs font-bold">
                      {r.totalSales !== null ? r.totalSales.toLocaleString('ja-JP') : '—'}
                    </td>
                    <td className="p-1.5 font-mono text-right text-xs font-bold text-accent">
                      {r.avgNinjibai !== null ? r.avgNinjibai.toLocaleString('ja-JP') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gold border-t-2 border-ink font-mincho font-extrabold">
                  <td className="p-2 px-2 text-xs border-r border-ink sticky left-0 bg-gold z-10">
                    月合計
                  </td>
                  {stores.map((st) => {
                    const t = monthTotals[st.id];
                    return (
                      <Fragment key={st.id}>
                        <td className="p-2 font-mono text-right text-xs">
                          {t?.sales !== null && t?.sales !== undefined
                            ? t.sales.toLocaleString('ja-JP')
                            : '—'}
                        </td>
                        <td className="p-2 font-mono text-right text-xs border-r border-ink">
                          {t?.ninjibai !== null && t?.ninjibai !== undefined
                            ? t.ninjibai.toLocaleString('ja-JP')
                            : '—'}
                        </td>
                      </Fragment>
                    );
                  })}
                  <td className="p-2 font-mono text-right text-sm">
                    {grandSales > 0 ? grandSales.toLocaleString('ja-JP') : '—'}
                  </td>
                  <td className="p-2 font-mono text-right text-sm text-accent">
                    {grandNinjibai !== null ? grandNinjibai.toLocaleString('ja-JP') : '—'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="mb-8 grid grid-cols-2 md:grid-cols-4 border-2 border-ink">
            <SummaryCell label="月間合計売上" value={formatJpy(grandSales)} hero />
            <SummaryCell label="月間総労働時間" value={`${grandHours.toFixed(1)} h`} />
            <SummaryCell
              label="平均人時売"
              value={grandNinjibai !== null ? formatJpy(grandNinjibai) + ' /h' : '—'}
            />
            <SummaryCell
              label="日報提出日数"
              value={`${salesRows.filter((r) => r.totalSales !== null).length} 日`}
            />
          </div>

          {/* ===== シフト ===== */}
          <h2 className="font-mincho text-xl font-extrabold mb-3 flex items-center gap-2 before:content-[''] before:w-4 before:h-0.5 before:bg-ink">
            ワークスケジュール
          </h2>

          <div className="flex flex-wrap gap-3 mb-3 no-print">
            <div className="flex border-2 border-ink">
              {stores.map((st) => (
                <button
                  key={st.id}
                  onClick={() => setShiftStoreId(st.id)}
                  className={`px-4 py-2 font-mincho font-bold text-sm border-r-2 border-ink last:border-r-0 ${
                    shiftStoreId === st.id ? 'bg-ink text-paper' : 'bg-paper'
                  }`}
                >
                  {st.name}
                </button>
              ))}
            </div>
            <div className="flex border-2 border-ink">
              {(['plan', 'actual'] as EntryType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setShiftTab(t)}
                  className={`px-4 py-2 font-mincho font-bold text-sm border-r-2 border-ink last:border-r-0 ${
                    shiftTab === t ? 'bg-ink text-paper' : 'bg-paper'
                  }`}
                >
                  {t === 'plan' ? '予定' : '実績'}
                </button>
              ))}
            </div>
          </div>

          <div className="border-2 border-ink bg-paper overflow-x-auto">
            <table className="text-xs border-collapse">
              <thead>
                <tr className="bg-ink text-paper font-mincho">
                  <th className="p-2 border-r border-paper/30 sticky left-0 bg-ink z-10 min-w-[100px] text-left">
                    メンバー
                  </th>
                  {salesRows.map((r) => (
                    <th
                      key={r.date}
                      className={`p-1 border-r border-paper/20 font-mono font-normal min-w-[32px] ${
                        r.isWeekend ? 'text-gold' : ''
                      }`}
                    >
                      <div>{r.day}</div>
                      <div className="text-[9px] opacity-70">{r.dayName}</div>
                    </th>
                  ))}
                  <th className="p-2 bg-accent font-mincho min-w-[56px]">合計</th>
                </tr>
              </thead>
              <tbody>
                {shiftRowsForStore.length === 0 ? (
                  <tr>
                    <td colSpan={days.length + 2} className="p-6 text-center text-muted font-mono">
                      この月のシフトデータはありません
                    </td>
                  </tr>
                ) : (
                  shiftRowsForStore.map((m) => (
                    <tr key={m.key} className="border-b border-dotted border-stone-300">
                      <td className="p-2 font-bold border-r border-ink sticky left-0 bg-paper z-10 whitespace-nowrap">
                        {m.name}
                      </td>
                      {m.cells.map((h, i) => (
                        <td
                          key={i}
                          className={`p-1 font-mono text-center ${
                            salesRows[i]?.isWeekend ? 'bg-paper2' : ''
                          } ${h > 0 ? '' : 'text-stone-300'}`}
                        >
                          {h > 0 ? h.toFixed(1) : '·'}
                        </td>
                      ))}
                      <td className="p-2 font-mono text-right font-extrabold border-l border-ink">
                        {m.total.toFixed(1)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {shiftRowsForStore.length > 0 && (
                <tfoot>
                  <tr className="bg-gold border-t-2 border-ink font-mincho font-extrabold">
                    <td className="p-2 border-r border-ink sticky left-0 bg-gold z-10">日計</td>
                    {shiftDayTotals.map((t, i) => (
                      <td key={i} className="p-1 font-mono text-center">
                        {t > 0 ? t.toFixed(1) : '·'}
                      </td>
                    ))}
                    <td className="p-2 font-mono text-right text-sm border-l border-ink">
                      {shiftGrandTotal.toFixed(1)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
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
