import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import React from 'react';
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
  Font,
} from '@react-pdf/renderer';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// 日本語フォント(Google FontsのNoto Serif JP)
Font.register({
  family: 'NotoSerifJP',
  src: 'https://fonts.gstatic.com/ea/notoserifjp/v6/NotoSerifJP-Bold.otf',
});

const styles = StyleSheet.create({
  page: { padding: 36, fontFamily: 'NotoSerifJP', fontSize: 11 },
  title: { fontSize: 18, textAlign: 'center', paddingBottom: 10, marginBottom: 14, borderBottom: 2, borderColor: '#000' },
  meta: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14, fontSize: 10 },
  table: { borderTop: 1, borderLeft: 1, borderColor: '#000' },
  row: { flexDirection: 'row', borderBottom: 1, borderColor: '#000' },
  headRow: { backgroundColor: '#eee' },
  cellName: { width: '55%', padding: 6, borderRight: 1, borderColor: '#000' },
  cellQty: { width: '22.5%', padding: 6, textAlign: 'center', borderRight: 1, borderColor: '#000' },
  cellQtyLast: { width: '22.5%', padding: 6, textAlign: 'center' },
  zero: { color: '#bbb' },
  footer: { marginTop: 14, fontSize: 9, color: '#666', textAlign: 'right' },
});

type Row = {
  store_name: string;
  date: string;
  items: { name: string; planned_qty: number }[];
};

function OrderPdf({ rows, date }: { rows: Row[]; date: string }) {
  return (
    <Document>
      {rows.map((r, idx) => (
        <Page key={idx} size="A4" style={styles.page}>
          <Text style={styles.title}>惣菜本部 注文票</Text>
          <View style={styles.meta}>
            <Text>店舗: {r.store_name}</Text>
            <Text>納品希望: {nextDayJp(date)}</Text>
            <Text>発注日: {date}</Text>
          </View>
          <View style={styles.table}>
            <View style={[styles.row, styles.headRow]}>
              <Text style={styles.cellName}>品　　名</Text>
              <Text style={styles.cellQty}>予定</Text>
              <Text style={styles.cellQtyLast}>実績</Text>
            </View>
            {r.items.map((it, i) => (
              <View key={i} style={styles.row}>
                <Text style={[styles.cellName, it.planned_qty === 0 ? styles.zero : {}]}>{it.name}</Text>
                <Text style={[styles.cellQty, it.planned_qty === 0 ? styles.zero : {}]}>
                  {it.planned_qty}
                </Text>
                <Text style={styles.cellQtyLast}>—</Text>
              </View>
            ))}
          </View>
          <Text style={styles.footer}>DAILY-REPORT-SYS / {date}</Text>
        </Page>
      ))}
    </Document>
  );
}

function nextDayJp(dateStr: string): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  // 全店舗の当日日報
  const { data: reports } = await supabase
    .from('daily_reports')
    .select('id, store_id, stores(name)')
    .eq('report_date', date);

  if (!reports || reports.length === 0) {
    return new NextResponse('当日の日報がありません', { status: 404 });
  }

  // 商品マスタ(取扱中、並び順)
  const { data: products } = await supabase
    .from('products')
    .select('id, name, sort_order')
    .eq('is_active', true)
    .order('sort_order');

  const { data: orderLines } = await supabase
    .from('order_lines')
    .select('daily_report_id, product_id, planned_qty')
    .in('daily_report_id', reports.map((r) => r.id));

  const rows: Row[] = reports.map((r) => {
    const items = (products || []).map((p) => {
      const ol = (orderLines || []).find(
        (o) => o.daily_report_id === r.id && o.product_id === p.id
      );
      return { name: p.name, planned_qty: ol?.planned_qty || 0 };
    });
    return {
      store_name: (r.stores as any)?.name || `店舗${r.store_id}`,
      date,
      items,
    };
  });

  const buf = await renderToBuffer(<OrderPdf rows={rows} date={date} />);

  return new NextResponse(buf as any, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="order-${date}.pdf"`,
    },
  });
}
