'use client';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { formatJpy } from '@/lib/calc';

type OrderItem = {
  name: string;
  planned_qty: number;
  is_manual: boolean;
};

type QA = {
  question: string;
  answer: string;
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
  sozai_zan?: string | null;
  mochi_zan?: string | null;
  orders?: OrderItem[];
  qas?: QA[];
};

const WEATHER_LABEL: Record<string, string> = {
  sunny: '☀️ 晴れ',
  cloudy: '☁️ くもり',
  rainy: '☂️ 雨',
  snowy: '❄️ 雪',
};

export function DashboardView() {
  const [rows, setRows] = useState<DashRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: kpi } = await supabase
        .from('daily_kpi')
        .select('*')
        .eq('report_date', date);

      const { data: reports } = await supabase
        .from('daily_reports')
        .select('id, weather, report_text, kizuki, sozai_zan, mochi_zan, store_id, stores(name)')
        .eq('report_date', date);

      const reportIds = (reports || []).map((r) => r.id);
      const { data: orderLines } = reportIds.length
        ? await supabase
            .from('order_lines')
            .select('daily_report_id, product_id, item_name_manual, planned_qty, products(name, sort_order)')
            .in('daily_report_id', reportIds)
        : { data: [] };

      const { data: answers } = reportIds.length
        ? await supabase
            .from('report_answers')
            .select('daily_report_id, question_id, answer_text')
            .in('daily_report_id', reportIds)
        : { data: [] };

      const { data: questions } = await supabase
        .from('report_questions')
        .select('id, question, sort_order, is_active')
        .order('sort_order');
      const questionMap = new Map<number, { question: string; sort_order: number; is_active: boolean }>();
      for (const q of (questions || []) as any[]) {
        questionMap.set(q.id, { question: q.question, sort_order: q.sort_order, is_active: q.is_active });
      }

      const merged: DashRow[] = (kpi || []).map((k) => {
        const r = (reports || []).find((x) => x.id === k.daily_report_id) as any;
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

        const qas: QA[] = ((answers || []) as any[])
          .filter((a) => a.daily_report_id === k.daily_report_id)
          .map((a) => {
            const q = questionMap.get(a.question_id);
            return {
              question: q?.question || '(削除済み質問)',
              answer: a.answer_text || '',
              sort_key: q?.sort_order ?? 9999,
            };
          })
          .filter((qa) => qa.answer.trim() !== '')
          .sort((a, b) => a.sort_key - b.sort_key)
          .map(({ question, answer }) => ({ question, answer }));

        return {
          ...k,
          store_name: r?.stores?.name,
          weather: r?.weather,
          report_text: r?.report_text,
          kizuki: r?.kizuki,
          sozai_zan: r?.sozai_zan,
          mochi_zan: r?.mochi_zan,
          orders,
          qas,
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

      <div className="print-only mb-4">
        <h2 className="font-mincho text-xl font-extrabold">
          本部日報 — {date}
        </h2>
      </div>

      {loading ? (
        <div className="p-8 text-center font-mincho">読み込み中…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 border-2 border-ink mb-6">
            <KpiCell label="全社 人時売" value={overallNinjibai !== null ? formatJpy(overallNinjibai) + ' /h' : '—'} hero />
            <KpiCell label="合計売上" value={formatJpy(totalSales)} />
            <KpiCell label="総労働時間" value={`${totalHrs.toFixed(1)} h`} />
            <KpiCell label="日報提出" value={`${rows.length} / 2`} />
          </div>

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
                      <span className="px-2 py-0.5 border-1.5 border-paper">{WEATHER_LABEL[r.weather] || r.weather}</span>
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
                {(r.report_text || r.kizuki || r.sozai_zan || r.mochi_zan || (r.qas && r.qas.length > 0)) && (
                  <div className="border-t border-dashed border-ink p-4 bg-paper2 text-sm leading-relaxed">
                    {r.report_text && (
                      <div>
                        <b className="font-mincho text-accent mr-2">本日の営業を一言で</b>
                        {r.report_text}
                      </div>
                    )}
                    {r.sozai_zan && (
                      <div className="mt-1">
                        <b className="font-mincho text-accent mr-2">惣菜残(14時時点)</b>
                        {r.sozai_zan}
                      </div>
                    )}
                    {r.mochi_zan && (
                      <div className="mt-1">
                        <b className="font-mincho text-accent mr-2">餅残</b>
                        {r.mochi_zan}
                      </div>
                    )}
                    {r.qas && r.qas.map((qa, i) => (
                      <div key={i} className="mt-1 whitespace-pre-wrap">
                        <b className="font-mincho text-accent mr-2">{qa.question}</b>
                        {qa.answer}
                      </div>
                    ))}
                    {r.kizuki && (
                      <div className="mt-1">
                        <b className="font-mincho text-accent mr-2">気づき</b>
                        {r.kizuki}
                      </div>
                    )}
                  </div>
                )}
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
