'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatJpy } from '@/lib/calc';

type OrderItem = {
  name: string;
  planned_qty: number;
  is_manual: boolean;
};

type DashRow = {
  daily_report_id: number;
  store_id: number;
  report_date: string;
  sales_actual: number | null;
  sales_forecast: number | null;
  customer_count: number | null;
  total_hours: number | null;
  ninjibai: number | null;
  kyaku_tanka: number | null;
  store_name?: string;
  weather?: string | null;
  report_text?: string | null;
  kizuki?: string | null;
  orders?: OrderItem[];
};

const WEATHER_LABEL: Record<string, string> = {
  sunny: '☀️ 晴れ',
  cloudy: '☁️ くもり',
  rainy: '☂️ 雨',
  snowy: '❄️ 雪',
};

export default function DashboardPage() {
  const [rows, setRows] = useState<DashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    (async () => {
      setLoading(true);
      // daily_kpiビューから取得 + stores, daily_reports をjoin
      const { data: kpi } = await supabase
        .from('daily_kpi')
        .select('*')
        .eq('report_date', date);

      const { data: reports } = await supabase
        .from('daily_reports')
        .select('id, weather, report_text, kizuki, store_id, stores(name)')
        .eq('report_date', date);

      // 注文明細(本部ログイン済みなので直接SELECT可)
      const reportIds = (reports || []).map((r) => r.id);
      const { data: orderLines } = reportIds.length
        ? await supabase
            .from('order_lines')
            .select('daily_report_id, product_id, item_name_manual, planned_qty, products(name, sort_order)')
            .in('daily_report_id', reportIds)
        : { data: [] };

      const merged: DashRow[] = (kpi || []).map((k) => {
        const r = (reports || []).find((x) => x.id === k.daily_report_id) as any;
        // この日報の注文を整形(マスタ商品はマスタ順、臨時商品は末尾)
        const orders: OrderItem[] = ((orderLines || []) as any[])
          .filter((o) => o.daily_report_id === k.daily_report_id)
          .map((o) => ({
            name: o.product_id ? o.products?.name || '(不明)' : o.item_name_manual || '(不明)',
            planned_qty: o.planned_qty,
            is_manual: o.product_id === null,
            sort_key: o.product_id ? o.products?.sort_order ?? 9999 : 9999,
          }))
          .sort((a, b) => a.sort_key - b.sort_key)
          .map(({ name, planned_qty, is_manual }) => ({ name, planned_qty, is_manual }));

        return {
          ...k,
          store_name: r?.stores?.name,
          weather: r?.weather,
          report_text: r?.report_text,
          kizuki: r?.kizuki,
          orders,
        };
      });
      setRows(merged);
      setLoading(false);
    })();
  }, [date]);

  const totalSales = rows.reduce((s, r) => s + (r.sales_actual || 0), 0);
  const totalHrs = rows.reduce((s, r) => s + Number(r.total_hours || 0), 0);
  const overallNinjibai = totalHrs > 0 ? Math.round(totalSales / totalHrs) : null;

  return (
    <div className="p-6 max-w-6xl mx-auto print-area">
      <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div>
          <h1 className="font-mincho text-3xl font-extrabold">本部ダッシュボード</h1>
          <p className="text-xs text-muted font-mono mt-1 tracking-wider">HQ · {date}</p>
        </div>
        <div className="flex gap-2 items-center no-print">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border-2 border-ink p-2 font-mono"
          />
          <a
            href={`/api/order-pdf?date=${date}`}
            target="_blank"
            className="px-5 py-3 bg-accent text-paper border-2 border-ink font-mincho font-extrabold shadow-inkSm hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-ink transition-all"
          >
            📄 注文票PDF出力
          </a>
          <button
            onClick={() => window.print()}
            className="px-5 py-3 bg-ink text-paper border-2 border-ink font-mincho font-extrabold shadow-inkSm hover:translate-x-[-2px] hover:translate-y-[-2px] hover:shadow-ink transition-all"
          >
            🖨 印刷
          </button>
        </div>
      </div>

      {/* 印刷時のみ表示される日付見出し */}
      <div className="print-only mb-4">
        <h2 className="font-mincho text-xl font-extrabold">
          本部日報 — {date}
        </h2>
      </div>

      {loading ? (
        <div className="p-8 text-center font-mincho">読み込み中…</div>
      ) : (
        <>
          {/* KPIストリップ */}
          <div className="grid grid-cols-2 md:grid-cols-4 border-2 border-ink mb-6">
            <KpiCell label="全社 人時売" value={overallNinjibai !== null ? formatJpy(overallNinjibai) + ' /h' : '—'} hero />
            <KpiCell label="合計売上" value={formatJpy(totalSales)} />
            <KpiCell label="総労働時間" value={`${totalHrs.toFixed(1)} h`} />
            <KpiCell label="日報提出" value={`${rows.length} / 2`} />
          </div>

          {/* 店舗カード */}
          {rows.length === 0 ? (
            <div className="border-2 border-ink p-12 bg-paper text-center font-mincho text-muted">
              この日の日報はまだ提出されていません
            </div>
          ) : (
            rows.map((r) => (
              <div key={r.daily_report_id} className="store-card-print border-2 border-ink mb-4 bg-paper">
                <div className="px-4 py-3 bg-ink text-paper flex items-center justify-between flex-wrap gap-2">
                  <h3 className="font-mincho text-lg font-extrabold">{r.store_name}</h3>
                  <div className="flex gap-2 text-xs">
                    {r.weather && (
                      <span className="px-2 py-0.5 border-1.5 border-paper">{WEATHER_LABEL[r.weather]}</span>
                    )}
                  </div>
                </div>
                <div className="p-4 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <Field label="人時売" value={r.ninjibai !== null ? formatJpy(r.ninjibai) : '—'} hi />
                  <Field label="売上実績" value={formatJpy(r.sales_actual)} />
                  <Field label="客単価" value={r.kyaku_tanka !== null ? formatJpy(r.kyaku_tanka) : '—'} />
                  <Field label="客数" value={r.customer_count !== null ? `${r.customer_count}人` : '—'} />
                  <Field label="総時間" value={r.total_hours !== null ? `${Number(r.total_hours).toFixed(1)}h` : '—'} />
                </div>
                {(r.report_text || r.kizuki) && (
                  <div className="border-t border-dashed border-ink p-4 bg-paper2 text-sm leading-relaxed">
                    {r.report_text && (
                      <div>
                        <b className="font-mincho text-accent mr-2">日報</b>
                        {r.report_text}
                      </div>
                    )}
                    {r.kizuki && (
                      <div className="mt-1">
                        <b className="font-mincho text-accent mr-2">気づき</b>
                        {r.kizuki}
                      </div>
                    )}
                  </div>
                )}
                {/* 本部への注文 */}
                <div className="border-t border-dashed border-ink p-4">
                  <b className="font-mincho text-accent text-sm block mb-2">本部への注文</b>
                  {r.orders && r.orders.length > 0 ? (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5">
                      {r.orders.map((o, i) => (
                        <div
                          key={i}
                          className="flex items-baseline justify-between border-b border-dotted border-stone-300 pb-0.5 text-sm"
                        >
                          <span className="flex items-center gap-1">
                            {o.name}
                            {o.is_manual && (
                              <span className="text-[9px] font-bold px-1 border border-ink bg-amber-100 font-mono">
                                臨時
                              </span>
                            )}
                          </span>
                          <span className="font-mono font-bold">{o.planned_qty}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-xs text-muted font-mono">注文なし</span>
                  )}
                </div>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

function KpiCell({ label, value, hero }: { label: string; value: string; hero?: boolean }) {
  return (
    <div className={`p-4 border-r-2 border-ink last:border-r-0 ${hero ? 'bg-ink text-paper' : 'bg-paper2'}`}>
      <div className={`font-mincho text-[11px] font-bold tracking-widest mb-2 ${hero ? 'opacity-70' : 'text-muted'}`}>
        {label}
      </div>
      <div className={`font-mono text-2xl font-extrabold leading-none ${hero ? 'text-gold' : ''}`}>
        {value}
      </div>
    </div>
  );
}

function Field({ label, value, hi }: { label: string; value: string; hi?: boolean }) {
  return (
    <div>
      <b className="block font-mincho text-muted text-[11px] font-bold tracking-wider mb-1">{label}</b>
      <span className={`font-mono font-bold ${hi ? 'text-accent text-xl' : 'text-base'}`}>{value}</span>
    </div>
  );
}
