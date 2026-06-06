'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  Store, Staff, Product, ShiftEntry, EntryType, ShiftPattern,
  ReportQuestion,
} from '@/lib/types';
import { totalHours, ninjibai, kyakuTanka, formatJpy, shiftMinutes } from '@/lib/calc';
import { NumInput } from '@/components/staff/NumInput';
import { OrderRow } from '@/components/staff/OrderRow';
import { ShiftRow } from '@/components/staff/ShiftRow';
import { ShiftEditor } from '@/components/staff/ShiftEditor';
import { AddStaffRow } from '@/components/staff/AddStaffRow';
import { AddOrderRow } from '@/components/staff/AddOrderRow';

type ReportState = {
  sales_forecast: number | null;
  sales_actual: number | null;
  customer_count: number | null;
  sozai_zan: string;
  mochi_zan: string;
  report_text: string;
};

type LocalShift = ShiftEntry;

// 注文行(マスタ商品 or 臨時商品)
type LocalOrder = {
  rowId: number; // 画面内の一意キー
  product_id: number | null;
  item_name_manual: string | null;
  planned_qty: number;
};

let localIdCounter = -1;
function nextLocalId(): number {
  return localIdCounter--;
}

// 備考欄の季節限定テンプレート(うなぎ予約 / プレミアム商品券)
// 期間外なら表示しない(切替は MONTHS を編集)
const BIKOU_TEMPLATE_MONTHS = [6, 7]; // 6月・7月
const BIKOU_TEMPLATE = 'うなぎの予約数累計＝\nプレミアム商品券の使用枚数＝';
function getBikouTemplate(): string {
  return BIKOU_TEMPLATE_MONTHS.includes(new Date().getMonth() + 1)
    ? BIKOU_TEMPLATE
    : '';
}

export default function TodayPage({ params }: { params: { slug: string } }) {
  const slug = params.slug;

  const [store, setStore] = useState<Store | null>(null);
  const [staffList, setStaffList] = useState<Staff[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  const [report, setReport] = useState<ReportState>({
    sales_forecast: null,
    sales_actual: null,
    customer_count: null,
    sozai_zan: '',
    mochi_zan: '',
    report_text: '',
  });
  const [questions, setQuestions] = useState<ReportQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [shifts, setShifts] = useState<LocalShift[]>([]);
  const [orders, setOrders] = useState<LocalOrder[]>([]);

  // dx."Sale" 由来の売上・客数・天気(前年予測 / 当日実績 / 当日客数 / 当日天気)
  const [dxForecast, setDxForecast] = useState<number | null>(null);
  const [dxActual, setDxActual] = useState<number | null>(null);
  const [dxCustomerCount, setDxCustomerCount] = useState<number | null>(null);
  const [dxWeather, setDxWeather] = useState<string | null>(null);

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

      // 質問マスタ(有効分)を取得
      const { data: qData } = await supabase
        .from('report_questions')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');
      const qList = (qData || []) as ReportQuestion[];
      setQuestions(qList);

      // 日報・シフト・注文を一括取得(RPC経由でRLSを貫通)
      const { data: full, error: e2 } = await supabase.rpc('get_today_full', { p_slug: slug });
      if (e2) {
        setError(e2.message);
        setLoading(false);
        return;
      }

      if (full && full.has_report && full.report) {
        const r = full.report;
        setReport({
          sales_forecast: r.sales_forecast,
          sales_actual: r.sales_actual,
          customer_count: r.customer_count,
          sozai_zan: r.sozai_zan || '',
          mochi_zan: r.mochi_zan || '',
          report_text: r.report_text || '',
        });

        // 既存の回答を取得して、質問IDをキーにしたマップに
        const { data: aData } = await supabase
          .from('report_answers')
          .select('question_id, answer_text')
          .eq('daily_report_id', r.id);
        const ansMap: Record<number, string> = {};
        for (const a of (aData || []) as { question_id: number; answer_text: string | null }[]) {
          ansMap[a.question_id] = a.answer_text || '';
        }
        // 未回答の質問には initial_value を初期値として入れる
        for (const q of qList) {
          if (ansMap[q.id] === undefined) {
            ansMap[q.id] = q.initial_value || '';
          }
        }
        setAnswers(ansMap);

        // シフト(RPCがjsonb配列で返す)
        setShifts((full.shifts || []) as LocalShift[]);

        // 注文(マスタ商品・臨時商品どちらも配列で保持)
        const loadedOrders: LocalOrder[] = ((full.orders || []) as any[]).map((o) => ({
          rowId: nextLocalId(),
          product_id: o.product_id ?? null,
          item_name_manual: o.item_name_manual ?? null,
          planned_qty: o.planned_qty,
        }));
        setOrders(loadedOrders);

        // 保存時刻表示
        if (r.updated_at) {
          const d = new Date(r.updated_at);
          setSavedAt(d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }));
        }
      } else {
        // 日報がまだ無い → 質問は initial_value(備考は季節テンプレ)で初期化
        setShifts([]);
        setOrders([]);
        const ansMap: Record<number, string> = {};
        for (const q of qList) {
          if (q.question === '備考') {
            ansMap[q.id] = q.initial_value || getBikouTemplate();
          } else {
            ansMap[q.id] = q.initial_value || '';
          }
        }
        setAnswers(ansMap);
      }

      // dx.sale から「前年同曜日売上」と「当日売上」を取得
      const today = new Date().toISOString().slice(0, 10);
      const { data: sales } = await supabase.rpc('get_dx_sales', {
        p_store_slug: slug,
        p_today: today,
      });
      setDxForecast(sales?.forecast != null ? Number(sales.forecast) : null);
      setDxActual(sales?.actual != null ? Number(sales.actual) : null);
      setDxCustomerCount(
        sales?.customer_count != null ? Number(sales.customer_count) : null
      );
      setDxWeather(sales?.weather ?? null);

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

  // 注文: マスタ商品を追加
  const addOrderFromMaster = (productId: number) => {
    // 既に追加済みなら何もしない
    if (orders.some((o) => o.product_id === productId)) return;
    setOrders((prev) => [
      ...prev,
      { rowId: nextLocalId(), product_id: productId, item_name_manual: null, planned_qty: 1 },
    ]);
    markDirty();
  };

  // 注文: 臨時商品を追加(registerToMaster=true なら商品マスタにも登録)
  const addOrderManual = async (name: string, registerToMaster: boolean) => {
    if (registerToMaster) {
      // 商品マスタに登録(RPC経由でRLSを貫通)
      const { data: newProduct, error: e } = await supabase.rpc('add_product', {
        p_name: name,
        p_category: 'その他',
      });
      if (e) {
        setError(e.message);
        return;
      }
      const np = newProduct as Product;
      setProducts((prev) => [...prev, np]);
      setOrders((prev) => [
        ...prev,
        { rowId: nextLocalId(), product_id: np.id, item_name_manual: null, planned_qty: 1 },
      ]);
    } else {
      // 今回だけの臨時商品
      setOrders((prev) => [
        ...prev,
        { rowId: nextLocalId(), product_id: null, item_name_manual: name, planned_qty: 1 },
      ]);
    }
    markDirty();
  };

  // 注文: 数量変更
  const updateOrderQty = (rowId: number, qty: number) => {
    setOrders((prev) => prev.map((o) => (o.rowId === rowId ? { ...o, planned_qty: qty } : o)));
    markDirty();
  };

  // 注文: 行削除
  const removeOrder = (rowId: number) => {
    setOrders((prev) => prev.filter((o) => o.rowId !== rowId));
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

      const ordersPayload = orders
        .filter((o) => o.planned_qty > 0)
        .map((o) => ({
          product_id: o.product_id,
          item_name_manual: o.item_name_manual,
          planned_qty: o.planned_qty,
        }));

      // 動的回答ペイロード(有効な質問のみ、空文字を除外せずそのまま記録)
      const answersPayload = questions.map((q) => ({
        question_id: q.id,
        answer_text: answers[q.id] ?? null,
      }));

      // 保存時にも dx.sale を最新で引き直して daily_reports に記録
      const today = new Date().toISOString().slice(0, 10);
      const { data: latestSales } = await supabase.rpc('get_dx_sales', {
        p_store_slug: slug,
        p_today: today,
      });
      const latestForecast =
        latestSales?.forecast != null ? Number(latestSales.forecast) : null;
      const latestActual =
        latestSales?.actual != null ? Number(latestSales.actual) : null;
      const latestCustomerCount =
        latestSales?.customer_count != null
          ? Number(latestSales.customer_count)
          : null;
      const latestWeather = (latestSales?.weather as string | null) ?? null;

      const { error: e } = await supabase.rpc('save_daily_report_full', {
        p_slug: slug,
        p_weather: latestWeather,
        p_sales_forecast: latestForecast,
        p_sales_actual: latestActual,
        p_customer_count: latestCustomerCount,
        p_sozai_zan: report.sozai_zan || null,
        p_mochi_zan: report.mochi_zan || null,
        p_report_text: report.report_text || null,
        p_kizuki: null,
        p_bikou: null,
        p_shifts: shiftsPayload,
        p_orders: ordersPayload,
        p_answers: answersPayload,
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
  // 売上は dx.sale 由来の値を使用(入力フィールドではなくテーブル参照)
  const visibleShifts = shifts.filter((s) => s.entry_type === shiftTab);
  const totalH = totalHours(shifts);
  const kpi = ninjibai(dxActual, totalH);
  const tanka = kyakuTanka(dxActual, dxCustomerCount);

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

      {/* 日報(一番上) */}
      <Section label="本日の営業を一言で" hideTitle>
        <TextArea label="日報" value={report.report_text} onChange={(v) => updateReport({ report_text: v })} />
      </Section>

      {/* シフト */}
      <Section label="ワークスケジュール" hideTitle>
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
              = {formatJpy(dxActual)} ÷ {totalH.toFixed(1)}h
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

      {/* 売上 */}
      <Section label="売上" hideTitle>
        <p className="mb-3 text-xs font-bold text-accent">
          ※野菜果物注文の売上実績から入力してください。
        </p>
        <ReadonlyText   label="天気"           value={dxWeather} />
        <ReadonlyAmount label="売上予測(前年)" value={dxForecast} unit="円" />
        <ReadonlyAmount label="売上実績"       value={dxActual}   unit="円" />
        <ReadonlyAmount label="客数"           value={dxCustomerCount} unit="人" />
        {tanka !== null && (
          <div className="mt-1 text-xs font-mono text-muted text-right">
            客単価 {formatJpy(tanka)}
          </div>
        )}
      </Section>

      {/* 気づき・残数(シフトの下) */}
      <Section label="気づき・残数" hideTitle>
        <TextArea
          label="惣菜残(14時時点)"
          value={report.sozai_zan}
          onChange={(v) => updateReport({ sozai_zan: v })}
        />
        <TextArea
          label="餅残"
          value={report.mochi_zan}
          onChange={(v) => updateReport({ mochi_zan: v })}
        />
        {/* 質問マスタから動的に生成される項目 */}
        {questions.map((q) => (
          <DynamicField
            key={q.id}
            question={q}
            value={answers[q.id] ?? ''}
            onChange={(v) => {
              setAnswers((prev) => ({ ...prev, [q.id]: v }));
              markDirty();
            }}
          />
        ))}
      </Section>

      {/* 本部注文(一番下) */}
      <Section label="本部への注文" hideTitle>
        <div className="border-2 border-ink bg-paper">
          {orders.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted font-mono">
              ↓ 注文する商品を追加してください
            </div>
          ) : (
            <div className="px-3">
              {orders.map((o) => {
                const master = o.product_id
                  ? products.find((p) => p.id === o.product_id)
                  : null;
                const name = master ? master.name : o.item_name_manual || '(不明)';
                return (
                  <OrderRow
                    key={o.rowId}
                    name={name}
                    qty={o.planned_qty}
                    isManual={o.product_id === null}
                    onChange={(v) => updateOrderQty(o.rowId, v)}
                    onDelete={() => removeOrder(o.rowId)}
                  />
                );
              })}
            </div>
          )}
          <AddOrderRow
            products={products}
            usedProductIds={orders
              .map((o) => o.product_id)
              .filter((x): x is number => x !== null)}
            onAddFromMaster={addOrderFromMaster}
            onAddManual={addOrderManual}
          />
        </div>
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
      <div className="font-mincho text-base font-extrabold text-ink tracking-widest mb-3 flex items-center gap-2 before:content-[''] before:w-4 before:h-0.5 before:bg-ink">
        {label}
      </div>
      {!hideTitle && title && (
        <h2 className="font-mincho text-xl font-extrabold mb-4 leading-tight">{title}</h2>
      )}
      {children}
    </div>
  );
}

function DynamicField({
  question,
  value,
  onChange,
}: {
  question: ReportQuestion;
  value: string;
  onChange: (v: string) => void;
}) {
  switch (question.input_type) {
    case 'textarea':
      return <TextArea label={question.question} value={value} onChange={onChange} />;
    case 'text':
      return (
        <div className="mb-3">
          <label className="block text-xs font-bold mb-1.5 text-muted">{question.question}</label>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full p-3 border-2 border-ink bg-paper text-sm"
          />
        </div>
      );
    case 'number':
      return (
        <div className="mb-3">
          <label className="block text-xs font-bold mb-1.5 text-muted">{question.question}</label>
          <input
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^\d.-]/g, '');
              onChange(digits);
            }}
            className="w-full px-3 py-3 text-xl font-bold border-2 border-ink bg-paper font-mono text-right"
          />
        </div>
      );
    case 'checkbox':
      return (
        <div className="mb-3 flex items-center gap-2">
          <input
            type="checkbox"
            id={`q-${question.id}`}
            checked={value === 'true'}
            onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
            className="w-5 h-5 border-2 border-ink"
          />
          <label htmlFor={`q-${question.id}`} className="text-sm font-bold">
            {question.question}
          </label>
        </div>
      );
    default:
      return null;
  }
}

function ReadonlyText({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-bold mb-1.5 text-muted">{label}</label>
      <div className="px-3 py-3 text-xl font-bold border-2 border-ink bg-paper2 font-mono text-muted">
        {value || '—'}
      </div>
    </div>
  );
}

function ReadonlyAmount({
  label,
  value,
  unit,
}: {
  label: string;
  value: number | null;
  unit: string;
}) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-bold mb-1.5 text-muted">{label}</label>
      <div className="flex items-center gap-2">
        <div className="flex-1 px-3 py-3 text-xl font-bold border-2 border-ink bg-paper2 font-mono text-right text-muted">
          {value !== null ? Math.round(value).toLocaleString('ja-JP') : '—'}
        </div>
        <span className="text-sm font-bold text-muted min-w-[24px]">{unit}</span>
      </div>
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
