'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { Store, Staff, Product, ShiftEntry, Weather, EntryType, ShiftPattern } from '@/lib/types';
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

type LocalShift = ShiftEntry;

let localIdCounter = -1;
function nextLocalId(): number {
  return localIdCounter--;
}

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
  const [shifts, setShifts] = useState<LocalShift[]>([]);
  const [orders, setOrders] = useState<Record<number, number>>({});

  const [shiftTab, setShiftTab] = useState<EntryType>('actual');
  const [selectedShiftId, setSelectedShiftId] = useState<number | null>(null);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const markDirty = () => setIsDirty(true);

  // データフェッチ(初期ロード + タブ復帰時)
  const loadData = useCallback(async () => {
    try {
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

      const { data: staffData } = await supabase
        .from('staff')
        .select('*')
        .eq('store_id', s.id)
        .eq('is_active', true)
        .order('sort_order');
      setStaffList(staffData || []);

      const { data: prodData } = await supabase
        .from('products')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');
      setProducts(prodData || []);

      const { data: todayData } = await supabase.rpc('get_today_report', { p_slug: slug });
      if (todayData && todayData.length > 0) {
        const r = todayData[0];
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
        (orderData || []).forEach((o: any) => {
          orderMap[o.product_id] = o.planned_qty;
        });
        setOrders(orderMap);

        if (r.report_id) {
          const { data: lastSaved } = await supabase
            .from('daily_reports')
            .select('updated_at')
            .eq('id', r.report_id)
            .single();
          if (lastSaved?.updated_at) {
            const d = new Date(lastSaved.updated_at);
            setSavedAt(d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
          }
        }
      } else {
        setShifts([]);
        setOrders({});
      }
      setIsDirty(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // タブ復帰時の再フェッチ — 未保存変更がある時は上書きしない
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !isDirty) {
        loadData();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadData, isDirty]);

  // ページ離脱警告(未保存時)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // === ローカル更新(DB呼び出しなし) ===

  const updateReport = (patch: Partial<ReportState>) => {
    setReport((prev) => ({ ...prev, ...patch }));
    markDirty();
  };

  const updateShift = (id: number, patch: Partial<ShiftEntry>) => {
    setShifts((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    markDirty();
  };

  const addShift = (staffId: number | null, staffNameManual: string | null) => {
    const exists = shifts.some(
      (s) =>
        s.entry_type === shiftTab &&
        (staffId !== null ? s.staff_id === staffId : s.staff_name_manual === staffNameManual)
    );
    if (exists) return;

    const newId = nextLocalId();
    const newShift: LocalShift = {
      id: newId,
      daily_report_id: 0,
      staff_id: staffId,
      staff_name_manual: staffNameManual,
      entry_type: shiftTab,
      pattern: shiftTab === 'plan' ? ('first' as ShiftPattern) : null,
      start_time: shiftTab === 'actual' ? '09:00' : null,
      end_time: shiftTab === 'actual' ? '17:00' : null,
      break_minutes: 0,
      break_start: null,
      break_end: null,
    };
    setShifts((prev) => [...prev, newShift]);
    setSelectedShiftId(newId);
    markDirty();
  };

  const removeShift = (id: number) => {
    setShifts((prev) => prev.filter((s) => s.id !== id));
    if (selectedShiftId === id) setSelectedShiftId(null);
    markDirty();
  };

  const updateOrder = (productId: number, qty: number) => {
    setOrders((prev) => ({ ...prev, [productId]: qty }));
    markDirty();
  };

  // === 一括保存 ===

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      const shiftsPayload = shifts.map((s) => ({
        staff_id: s.staff_id,
        staff_name_manual: s.staff_name_manual,
        entry_type: s.entry_type,
        pattern: s.pattern,
        start_time: s.start_time,
        end_time: s.end_time,
        break_minutes: s.break_minutes,
        break_start: s.break_start,
        break_end: s.break_end,
      }));

      const ordersPayload = Object.entries(orders)
        .filter(([, qty]) => qty > 0)
        .map(([pid, qty]) => ({
          product_id: Number(pid),
          planned_qty: qty,
        }));

      const { error: e } = await supabase.rpc('save_daily_report_full', {
        p_slug: slug,
        p_weather: report.weather,
        p_sales_forecast: report.sales_forecast,
        p_sales_actual: report.sales_actual,
        p_customer_count: report.customer_count,
        p_sozai_zan: report.sozai_zan,
        p_mochi_zan: report.mochi_zan,
        p_report_text: report.report_text || null,
        p_kizuki: report.kizuki || null,
        p_bikou: report.bikou || null,
        p_shifts: shiftsPayload,
        p_orders: ordersPayload,
      });

      if (e) {
        setError(e.message);
      } else {
        setIsDirty(false);
        setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
        // 保存後にDBから再読込してidを最新化
        setSelectedShiftId(null);
        await loadData();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  // === 計算KPI ===
  const visibleShifts = shifts.filter((s) => s.entry_type === shiftTab);
  const totalH = totalHours(shifts);
  const kpi = ninjibai(report.sales_actual, totalH);
  const tanka = kyakuTanka(report.sales_actual, report.customer_count);

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
    <div className="max-w-md mx-auto bg-paper min-h-screen pb-24">
      {/* ヘッダ */}
      <div className="sticky top-0 z-10 px-5 py-4 border-b-2 border-ink bg-paper">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mincho text-xl font-extrabold leading-none">{store?.name}</div>
            <div className="font-mono text-xs text-muted mt-1 tracking-wider">{dateStr} ({dayName})</div>
          </div>
          {isDirty ? (
            <div className="flex items-center gap-1.5 px-2.5 py-1 border-2 border-accent bg-red-50">
              <span className="w-2.5 h-2.5 rounded-full bg-accent animate-pulse"></span>
              <span className="text-xs font-bold text-accent">未保存</span>
            </div>
          ) : savedAt ? (
            <div className="px-2.5 py-1 bg-accent2 text-paper text-xs font-bold">
              ✓ {savedAt}
            </div>
          ) : null}
        </div>
        {error && (
          <div className="mt-2 text-xs text-accent font-bold">⚠ {error}</div>
        )}
      </div>

      {/* 天気 */}
      <Section label="天気" hideTitle>
        <WeatherPicker value={report.weather} onChange={(v) => updateReport({ weather: v })} />
      </Section>

      {/* 売上 */}
      <Section label="売上" title="予測 → 実績">
        <NumInput
          label="売上予測(前年)"
          unit="円"
          value={report.sales_forecast}
          onChange={(v) => updateReport({ sales_forecast: v })}
        />
        <NumInput
          label="売上実績"
          unit="円"
          value={report.sales_actual}
          onChange={(v) => updateReport({ sales_actual: v })}
        />
        <NumInput
          label="客数"
          unit="人"
          value={report.customer_count}
          onChange={(v) => updateReport({ customer_count: v })}
        />
        {tanka !== null && (
          <div className="mt-1 text-xs font-mono text-muted text-right">
            客単価 {formatJpy(tanka)}
          </div>
        )}
      </Section>

      {/* シフト */}
      <Section label="ワークスケジュール" title="シフト">
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
                onDelete={() => removeShift(s.id)}
              />
            ))
          )}

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
            onChange={(patch) => updateShift(selectedShift.id, patch)}
          />
        )}

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
      </Section>

      {/* 本部注文 */}
      <Section label="本部への注文" title="明日の注文票">
        {products.map((p) => (
          <OrderRow
            key={p.id}
            name={p.name}
            qty={orders[p.id] || 0}
            onChange={(v) => updateOrder(p.id, v)}
          />
        ))}
      </Section>

      {/* 日報 */}
      <Section label="日報・気づき" title="ひとこと">
        <TextArea label="日報" value={report.report_text} onChange={(v) => updateReport({ report_text: v })} />
        <TextArea label="気づき" value={report.kizuki} onChange={(v) => updateReport({ kizuki: v })} />
        <TextArea
          label="惣菜残・餅残・備考"
          value={report.bikou}
          onChange={(v) => updateReport({ bikou: v })}
        />
        <NumInput
          label="惣菜残(14時時点)"
          unit="点"
          value={report.sozai_zan}
          onChange={(v) => updateReport({ sozai_zan: v })}
        />
        <NumInput
          label="餅残"
          unit="点"
          value={report.mochi_zan}
          onChange={(v) => updateReport({ mochi_zan: v })}
        />
      </Section>

      {/* 画面下部に固定保存ボタン */}
      <div className="fixed bottom-0 left-0 right-0 z-20 bg-paper border-t-2 border-ink shadow-[0_-4px_0_rgba(26,24,20,0.1)]">
        <div className="max-w-md mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex-1 text-xs">
            {isDirty ? (
              <span className="font-bold text-accent flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-accent animate-pulse"></span>
                未保存の変更があります
              </span>
            ) : savedAt ? (
              <span className="text-muted font-mono">最終保存 {savedAt}</span>
            ) : (
              <span className="text-muted">未入力</span>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
            className={`px-6 py-3 border-2 border-ink font-mincho font-extrabold text-base tracking-wider transition-all ${
              saving
                ? 'bg-stone-400 text-paper'
                : isDirty
                ? 'bg-accent text-paper shadow-inkSm active:translate-x-[1px] active:translate-y-[1px] active:shadow-none'
                : 'bg-stone-200 text-stone-500'
            }`}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
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
