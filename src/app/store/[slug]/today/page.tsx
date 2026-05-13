'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type { Store, Staff, Product, ShiftEntry, Weather, EntryType, OrderExtra } from '@/lib/types';
import { totalHours, ninjibai, kyakuTanka, formatJpy, shiftMinutes } from '@/lib/calc';
import { WeatherPicker } from '@/components/staff/WeatherPicker';
import { NumInput } from '@/components/staff/NumInput';
import { OrderRow } from '@/components/staff/OrderRow';
import { ShiftRow } from '@/components/staff/ShiftRow';
import { ShiftEditor } from '@/components/staff/ShiftEditor';
import { AddStaffRow } from '@/components/staff/AddStaffRow';

type ReportState = {
  weather: Weather | null;
  sales_forecast: number | null;
  sales_actual: number | null;
  customer_count: number | null;
  sozai_zan: number | null;
  mochi_zan: number | null;
  report_text: string;
  kizuki: string;
  bikou: string;
};

export default function TodayPage({ params }: { params: { slug: string } }) {
  const slug = params.slug;

  const [store, setStore] = useState<Store | null>(null);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [report, setReport] = useState<ReportState>({
    weather: null,
    sales_forecast: null,
    sales_actual: null,
    customer_count: null,
    sozai_zan: null,
    mochi_zan: null,
    report_text: '',
    kizuki: '',
    bikou: '',
  });
  const [shifts, setShifts] = useState<ShiftEntry[]>([]);
  const [orders, setOrders] = useState<Record<number, number>>({});
  const [extras, setExtras] = useState<OrderExtra[]>([]);
  const [reportId, setReportId] = useState<number | null>(null);
  const [newExtraName, setNewExtraName] = useState('');
  const [shiftTab, setShiftTab] = useState<EntryType>('actual');
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // 初期ロード
  useEffect(() => {
    (async () => {
      try {
        // 店舗特定
        const { data: s, error: e1 } = await supabase
          .from('stores')
          .select('*')
          .eq('slug', slug)
          .eq('is_active', true)
          .single();
        if (e1 || !s) {
          setError('店舗が見つかりません');
          setLoading(false);
          return;
        }
        setStore(s);

        // スタッフマスタ
        const { data: staffData } = await supabase
          .from('staff')
          .select('*')
          .eq('store_id', s.id)
          .eq('is_active', true)
          .order('sort_order');
        setStaffList(staffData || []);

        // 商品マスタ
        const { data: prodData } = await supabase
          .from('products')
          .select('*')
          .eq('is_active', true)
          .order('sort_order');
        setProducts(prodData || []);

        // 今日の日報
        const { data: todayData } = await supabase.rpc('get_today_report', { p_slug: slug });
        if (todayData && todayData.length > 0) {
          const r = todayData[0];
          setReportId(r.report_id);
          setReport({
            weather: r.weather,
            sales_forecast: r.sales_forecast,
            sales_actual: r.sales_actual,
            customer_count: r.customer_count,
            sozai_zan: r.sozai_zan,
            mochi_zan: r.mochi_zan,
            report_text: r.report_text || '',
            kizuki: r.kizuki || '',
            bikou: r.bikou || '',
          });

          // シフト・注文・臨時アイテムをロード
          const { data: shiftData } = await supabase
            .from('shift_entries')
            .select('*')
            .eq('daily_report_id', r.report_id)
            .order('id');
          setShifts(shiftData || []);

          const { data: orderData } = await supabase
            .from('order_lines')
            .select('*')
            .eq('daily_report_id', r.report_id);
          const orderMap: Record<number, number> = {};
          (orderData || []).forEach((o) => {
            orderMap[o.product_id] = o.planned_qty;
          });
          setOrders(orderMap);

          const { data: extraData } = await supabase
            .from('daily_order_extras')
            .select('*')
            .eq('daily_report_id', r.report_id)
            .order('id');
          setExtras(extraData || []);
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  // 日報の自動保存(debounce)
  const reportDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const saveReport = useCallback(
    (patch: Partial<ReportState>) => {
      const next = { ...report, ...patch };
      setReport(next);
      if (reportDebounceRef.current) clearTimeout(reportDebounceRef.current);
      reportDebounceRef.current = setTimeout(async () => {
        const { error: e } = await supabase.rpc('upsert_daily_report', {
          p_slug: slug,
          p_weather: next.weather,
          p_sales_forecast: next.sales_forecast,
          p_sales_actual: next.sales_actual,
          p_customer_count: next.customer_count,
          p_sozai_zan: next.sozai_zan,
          p_mochi_zan: next.mochi_zan,
          p_report_text: next.report_text,
          p_kizuki: next.kizuki,
          p_bikou: next.bikou,
        });
        if (e) setError(e.message);
        else setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
      }, 800);
    },
    [report, slug]
  );

  // シフト保存
  const saveShift = async (id: number, patch: Partial<ShiftEntry>) => {
    const target = shifts.find((s) => s.id === id);
    if (!target) return;
    const next = { ...target, ...patch };
    setShifts((prev) => prev.map((s) => (s.id === id ? next : s)));

    const { error: e } = await supabase.rpc('upsert_shift_entry', {
      p_slug: slug,
      p_shift_id: id > 0 ? id : null,
      p_staff_id: next.staff_id,
      p_staff_name_manual: next.staff_name_manual,
      p_entry_type: next.entry_type,
      p_pattern: next.pattern,
      p_start_time: next.start_time,
      p_end_time: next.end_time,
      p_break_minutes: next.break_minutes,
      p_break_start: next.break_start,
      p_break_end: next.break_end,
    });
    if (e) setError(e.message);
    else setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  };

  // シフト追加
  const addShift = async (staffId: number | null, staffNameManual: string | null) => {
    const newEntry: Partial<ShiftEntry> = {
      staff_id: staffId,
      staff_name_manual: staffNameManual,
      entry_type: shiftTab,
      pattern: shiftTab === 'plan' ? 'first' : null,
      start_time: shiftTab === 'actual' ? '09:00' : null,
      end_time: shiftTab === 'actual' ? '17:00' : null,
      break_minutes: 0,
      break_start: null,
      break_end: null,
    };

    const { data, error: e } = await supabase.rpc('upsert_shift_entry', {
      p_slug: slug,
      p_shift_id: null,
      p_staff_id: newEntry.staff_id,
      p_staff_name_manual: newEntry.staff_name_manual,
      p_entry_type: newEntry.entry_type,
      p_pattern: newEntry.pattern,
      p_start_time: newEntry.start_time,
      p_end_time: newEntry.end_time,
      p_break_minutes: newEntry.break_minutes,
      p_break_start: newEntry.break_start,
      p_break_end: newEntry.break_end,
    });
    if (e) {
      setError(e.message);
      return;
    }
    const newId = data as number;
    setShifts((prev) => [...prev, { ...(newEntry as ShiftEntry), id: newId, daily_report_id: 0 }]);
    setSelectedShiftId(newId);
    setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  };

  // シフト削除
  const deleteShift = async (id: number) => {
    setShifts((prev) => prev.filter((s) => s.id !== id));
    if (selectedShiftId === id) setSelectedShiftId(null);
    const { error: e } = await supabase.rpc('delete_shift_entry', {
      p_slug: slug,
      p_shift_id: id,
    });
    if (e) setError(e.message);
  };

  // 注文数量変更
  const setOrderQty = async (productId: number, qty: number) => {
    setOrders((prev) => ({ ...prev, [productId]: qty }));
    const { error: e } = await supabase.rpc('set_order_qty', {
      p_slug: slug,
      p_product_id: productId,
      p_planned_qty: qty,
    });
    if (e) setError(e.message);
    else setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  };

  // 日報idの確保(まだ無ければ作る)
  const ensureReportId = async (): Promise<number | null> => {
    if (reportId) return reportId;
    // 現在のreport stateで一旦保存して作成させる
    await supabase.rpc('upsert_daily_report', {
      p_slug: slug,
      p_weather: report.weather,
      p_sales_forecast: report.sales_forecast,
      p_sales_actual: report.sales_actual,
      p_customer_count: report.customer_count,
      p_sozai_zan: report.sozai_zan,
      p_mochi_zan: report.mochi_zan,
      p_report_text: report.report_text,
      p_kizuki: report.kizuki,
      p_bikou: report.bikou,
    });
    const { data } = await supabase.rpc('get_today_report', { p_slug: slug });
    if (data && data.length > 0) {
      setReportId(data[0].report_id);
      return data[0].report_id as number;
    }
    return null;
  };

  // 臨時アイテム追加
  const addExtra = async () => {
    const name = newExtraName.trim();
    if (!name) return;
    const rid = await ensureReportId();
    if (!rid) {
      setError('日報の作成に失敗しました');
      return;
    }
    const { data, error: e } = await supabase
      .from('daily_order_extras')
      .insert({ daily_report_id: rid, name, planned_qty: 0 })
      .select()
      .single();
    if (e || !data) {
      setError(e?.message || '追加に失敗しました');
      return;
    }
    setExtras((prev) => [...prev, data as OrderExtra]);
    setNewExtraName('');
    setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  };

  // 臨時アイテム数量変更
  const setExtraQty = async (id: number, qty: number) => {
    setExtras((prev) => prev.map((x) => (x.id === id ? { ...x, planned_qty: qty } : x)));
    const { error: e } = await supabase
      .from('daily_order_extras')
      .update({ planned_qty: qty })
      .eq('id', id);
    if (e) setError(e.message);
    else setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
  };

  // 臨時アイテム削除(物理削除)
  const deleteExtra = async (id: number) => {
    const prev = extras;
    setExtras((cur) => cur.filter((x) => x.id !== id));
    const { error: e } = await supabase.from('daily_order_extras').delete().eq('id', id);
    if (e) {
      setError(e.message);
      setExtras(prev);
    } else {
      setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
    }
  };

  // 計算KPI
  const visibleShifts = shifts.filter((s) => s.entry_type === shiftTab);
  const totalH = totalHours(shifts);
  const kpi = ninjibai(report.sales_actual, totalH);
  const tanka = kyakuTanka(report.sales_actual, report.customer_count);

  // 日報に最低1項目入力されているか(シフト/注文セクションのロック判定)
  const hasReportInput =
    report.weather !== null ||
    report.sales_forecast !== null ||
    report.sales_actual !== null ||
    report.customer_count !== null ||
    report.sozai_zan !== null ||
    report.mochi_zan !== null ||
    report.report_text.trim() !== '' ||
    report.kizuki.trim() !== '' ||
    report.bikou.trim() !== '';

  const getStaffName = (s: ShiftEntry): string => {
    if (s.staff_id) {
      const m = staffList.find((x) => x.id === s.staff_id);
      return m ? m.name : '(不明)';
    }
    return s.staff_name_manual || '(未設定)';
  };

  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, '0')}.${String(today.getDate()).padStart(2, '0')}`;
  const dayName = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][today.getDay()];

  if (loading) {
    return <div className="p-8 text-center font-mincho">読み込み中…</div>;
  }
  if (error && !store) {
    return <div className="p-8 text-center text-accent font-bold">{error}</div>;
  }

  const selectedShift = visibleShifts.find((s) => s.id === selectedShiftId);

  return (
    <div className="max-w-md mx-auto bg-paper min-h-screen">
      {/* ヘッダ */}
      <div className="sticky top-0 z-10 px-5 py-4 border-b-2 border-ink bg-paper">
        <div className="font-mincho text-xl font-extrabold leading-none">{store?.name}</div>
        <div className="font-mono text-xs text-muted mt-1 tracking-wider">{dateStr} ({dayName})</div>
        {savedAt && (
          <span className="inline-block mt-2 bg-accent2 text-paper px-2.5 py-0.5 text-xs font-bold">
            ✓ 保存済み {savedAt}
          </span>
        )}
        {error && (
          <div className="mt-2 text-xs text-accent font-bold">⚠ {error}</div>
        )}
        {!hasReportInput && (
          <div className="mt-2 px-2.5 py-1.5 bg-accent text-paper text-xs font-bold border-2 border-ink">
            ▸ 先に日報を入力してください（天気・売上・気づき等のいずれか）
          </div>
        )}
      </div>

      {/* 天気 */}
      <Section label="天気" hideTitle>
        <TextArea label="日報" value={report.report_text} onChange={(v) => saveReport({ report_text: v })} />
        <WeatherPicker value={report.weather} onChange={(v) => saveReport({ weather: v })} />
      </Section>

      {/* 売上 */}
      <Section label="売上" title="予測 → 実績">
        <NumInput
          label="売上予測(前年)"
          unit="円"
          value={report.sales_forecast}
          onChange={(v) => saveReport({ sales_forecast: v })}
        />
        <NumInput
          label="売上実績"
          unit="円"
          value={report.sales_actual}
          onChange={(v) => saveReport({ sales_actual: v })}
        />
        <NumInput
          label="客数"
          unit="人"
          value={report.customer_count}
          onChange={(v) => saveReport({ customer_count: v })}
        />
        {tanka !== null && (
          <div className="mt-1 text-xs font-mono text-muted text-right">
            客単価 {formatJpy(tanka)}
          </div>
        )}
      </Section>

      {/* シフト */}
      <Section label="ワークスケジュール" title="シフト">
        <div
          className={!hasReportInput ? 'pointer-events-none opacity-40 select-none' : ''}
          aria-disabled={!hasReportInput}
        >
        <div className="flex border-2 border-ink mb-3">
          {(['plan', 'actual'] as EntryType[]).map((t) => (
            <button
              key={t}
              onClick={() => {
                setShiftTab(t);
                setSelectedShiftId(null);
              }}
              className={`flex-1 py-2.5 font-mincho font-bold text-sm border-r-2 border-ink last:border-r-0 ${
                shiftTab === t ? 'bg-ink text-paper' : 'bg-paper'
              }`}
            >
              {t === 'plan' ? '予定' : '実績'}
            </button>
          ))}
        </div>

        <div className="border-2 border-ink bg-paper">
          <div className="grid grid-cols-[90px_1fr_50px] border-b-2 border-ink bg-paper2 font-mincho text-[11px] font-bold tracking-wider">
            <div className="p-2 border-r border-ink text-center">メンバー</div>
            <div className="p-1 border-r border-ink text-center text-[10px]">
              <div>9時 ─ 17時</div>
              <div className="grid grid-cols-8 font-mono text-[9px] text-muted mt-0.5">
                <span>9</span><span>10</span><span>11</span><span>12</span>
                <span>13</span><span>14</span><span>15</span><span>16</span>
              </div>
            </div>
            <div className="p-2 text-center">時間</div>
          </div>

          {visibleShifts.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted font-mono">
              ↓ スタッフを追加してください
            </div>
          ) : (
            visibleShifts.map((s) => (
              <ShiftRow
                key={s.id}
                entry={s}
                staffName={getStaffName(s)}
                selected={selectedShiftId === s.id}
                onSelect={() => setSelectedShiftId(s.id)}
                onDelete={() => deleteShift(s.id)}
              />
            ))
          )}

          {/* 総時間バー */}
          <div className="grid grid-cols-[90px_1fr_50px] bg-gold border-t-2 border-ink font-mincho font-extrabold">
            <div className="p-2.5 px-3 text-xs border-r border-ink">総時間数</div>
            <div className="border-r border-ink"></div>
            <div className="p-2.5 px-1 font-mono text-base text-center">
              {(visibleShifts.reduce((sum, s) => sum + shiftMinutes(s), 0) / 60).toFixed(1)}
            </div>
          </div>

          <AddStaffRow
            staffList={staffList}
            usedStaffIds={visibleShifts.map((s) => s.staff_id).filter((x): x is number => x !== null)}
            onAddFromMaster={(staffId) => addShift(staffId, null)}
            onAddManual={(name) => addShift(null, name)}
          />
        </div>

        {selectedShift && (
          <ShiftEditor
            entry={selectedShift}
            staffName={getStaffName(selectedShift)}
            onChange={(patch) => saveShift(selectedShift.id, patch)}
          />
        )}

        {/* 人時売 控えめ表示 */}
        <div className="mt-4 -mx-5 px-4 py-3 bg-paper2 border-t-2 border-ink flex items-center justify-between gap-3">
          <div className="font-mincho text-xs font-bold text-muted tracking-wider">
            人時売
            <small className="block font-mono text-[10px] opacity-80 mt-0.5">
              = {formatJpy(report.sales_actual)} ÷ {totalH.toFixed(1)}h
            </small>
          </div>
          <div className="text-right">
            <div className="font-mono text-xl font-extrabold leading-none">
              {kpi !== null ? kpi.toLocaleString('ja-JP') : '—'}
              <span className="text-[10px] text-muted ml-1 font-medium">円/h</span>
            </div>
          </div>
        </div>
        </div>
      </Section>
     {/* 日報 */}
      <Section label="日報・気づき" title="ひとこと">
        <TextArea label="気づき" value={report.kizuki} onChange={(v) => saveReport({ kizuki: v })} />
        <TextArea
          label="惣菜残・餅残・備考"
          value={report.bikou}
          onChange={(v) => saveReport({ bikou: v })}
        />
        <NumInput
          label="惣菜残(14時時点)"
          unit="点"
          value={report.sozai_zan}
          onChange={(v) => saveReport({ sozai_zan: v })}
        />
        <NumInput
          label="餅残"
          unit="点"
          value={report.mochi_zan}
          onChange={(v) => saveReport({ mochi_zan: v })}
        />
      </Section>

      {/* 本部注文 */}
      <Section label="本部への注文" title="明日の注文票">
        <div
          className={!hasReportInput ? 'pointer-events-none opacity-40 select-none' : ''}
          aria-disabled={!hasReportInput}
        >
        {products.map((p) => (
          <OrderRow
            key={`p-${p.id}`}
            name={p.name}
            qty={orders[p.id] || 0}
            onChange={(v) => setOrderQty(p.id, v)}
          />
        ))}
        {extras.map((x) => (
          <OrderRow
            key={`x-${x.id}`}
            name={`${x.name}  〔臨時〕`}
            qty={x.planned_qty}
            onChange={(v) => setExtraQty(x.id, v)}
            onDelete={() => deleteExtra(x.id)}
          />
        ))}

        <div className="mt-4 p-3 bg-paper2 border-2 border-dashed border-ink">
          <b className="font-mincho block mb-2 text-sm">＋ 臨時アイテムを追加</b>
          <p className="text-[11px] text-muted font-mono mb-2">※ 本日限り。翌日には引き継がれません</p>
          <div className="flex gap-2">
            <input
              placeholder="商品名"
              value={newExtraName}
              onChange={(e) => setNewExtraName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addExtra();
                }
              }}
              className="flex-1 p-2 border-2 border-ink bg-paper text-sm"
            />
            <button
              onClick={addExtra}
              className="px-4 py-2 bg-ink text-paper border-2 border-ink font-mincho font-bold text-sm"
            >
              追加
            </button>
          </div>
        </div>
        </div>
      </Section>

     
      <div className="p-4 bg-ink text-paper text-center font-mincho text-sm font-bold tracking-widest">
        自動保存されています
        <small className="block font-mono text-[10px] opacity-70 mt-1 tracking-widest">
          SALES / HOURS = 人時売
        </small>
      </div>
    </div>
  );
}

function Section({
  label,
  title,
  hideTitle,
  children,
}: {
  label: string;
  title?: string;
  hideTitle?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="px-5 py-5 border-b-2 border-ink">
      <div className="font-mincho text-xs font-bold text-muted tracking-widest mb-3 flex items-center gap-2 before:content-[''] before:w-4 before:h-0.5 before:bg-ink">
        {label}
      </div>
      {!hideTitle && title && (
        <h2 className="font-mincho text-xl font-extrabold mb-4 leading-tight">{title}</h2>
      )}
      {children}
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-bold mb-1.5 text-muted">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-h-[70px] p-3 border-2 border-ink bg-paper text-sm leading-relaxed resize-y"
      />
    </div>
  );
}
