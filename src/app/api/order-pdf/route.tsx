import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import React from 'react';
import path from 'path';
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

// 日本語フォント(public/fonts/ に同梱したファイルを参照)
// ※ 外部URLは404や障害のリスクがあるため同梱方式にしている
Font.register({
  family: 'NotoSansJP',
  src: path.join(process.cwd(), 'public', 'fonts', 'BIZUDPGothic-Regular.ttf'),
});

const styles = StyleSheet.create({
  page: { padding: 36, fontFamily: 'NotoSansJP', fontSize: 11 },
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
  items: { name: string; planned_qty: number; isManual: boolean }[];
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
            {r.items.length === 0 ? (
              <View style={styles.row}>
                <Text style={[styles.cellName, styles.zero]}>(注文なし)</Text>
                <Text style={[styles.cellQty, styles.zero]}>—</Text>
                <Text style={styles.cellQtyLast}>—</Text>
              </View>
            ) : (
              r.items.map((it, i) => (
                <View key={i} style={styles.row}>
                  <Text style={styles.cellName}>
                    {it.name}
                    {it.isManual ? '（臨時）' : ''}
                  </Text>
                  <Text style={styles.cellQty}>{it.planned_qty}</Text>
                  <Text style={styles.cellQtyLast}>—</Text>
                </View>
              ))
            )}
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
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { db: { schema: 'nippo' } }
  );

  // 指定日の全店舗の注文をRPC経由で取得(RLSを貫通)
  const { data: storeData, error } = await supabase.rpc('get_orders_for_pdf', {
    p_date: date,
  });

  if (error) {
    return new NextResponse(`取得エラー: ${error.message}`, { status: 500 });
  }

  const stores = (storeData || []) as {
    store_name: string;
    items: { name: string; planned_qty: number; is_manual: boolean; sort_key: number }[];
  }[];

  if (stores.length === 0) {
    return new NextResponse('当日の日報がありません', { status: 404 });
  }

  const rows: Row[] = stores.map((s) => ({
    store_name: s.store_name,
    date,
    items: s.items.map((it) => ({
      name: it.name || '(不明)',
      planned_qty: it.planned_qty,
      isManual: it.is_manual,
    })),
  }));

  const buf = await renderToBuffer(<OrderPdf rows={rows} date={date} />);

  return new NextResponse(buf as any, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="order-${date}.pdf"`,
    },
  });
}
