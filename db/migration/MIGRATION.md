# DB 移行手順 — 現行 Supabase → DXシステム側 Supabase (`nippo` スキーマ)

すべて Supabase Dashboard の **SQL Editor** だけで完結します。
3ステップで終わります。

---

## 移行先プロジェクト情報

- URL: `https://useoasbqbccgaznyhnma.supabase.co`
- anon キー: Dashboard → Project Settings → API から取得し、ローカル `.env.local` に貼る

---

## Step 1 — 移行先で nippo スキーマと全テーブルを作成

移行先 Dashboard → **SQL Editor** で `01_setup_target.sql` を **そのまま** 実行。

これで以下まで揃います:

- `nippo` スキーマ + 権限
- 全 6 テーブル(`stores`, `staff`, `products`, `daily_reports`, `shift_entries`, `order_lines`)
- インデックス / FK / CHECK 制約 / UNIQUE
- `updated_at` 自動更新トリガ(全テーブル)

実行後、Dashboard → **Project Settings → API → Exposed schemas** に `nippo` を追加。

---

## Step 2 — View と RPC を移行先に作成

**移行元** SQL Editor で `02_dump_runtime.sql` を実行。

結果は **5 行・1 列**(`ddl_text`)のテーブルで返ります:

| 行 | 中身 |
|---|---|
| 1 | `CREATE OR REPLACE VIEW nippo.daily_kpi …` |
| 2 | `CREATE FUNCTION nippo.add_product(…) …` |
| 3 | `CREATE FUNCTION nippo.get_orders_for_pdf(…) …` |
| 4 | `CREATE FUNCTION nippo.get_today_full(…) …` |
| 5 | `CREATE FUNCTION nippo.save_daily_report_full(…) …` |

**各行の `ddl_text` セルをクリック** → 全文表示 → コピー → **移行先** SQL Editor に貼って実行。
これを 5 回繰り返す(順番は問わない)。

---

## Step 3 — データを移行

**移行元** SQL Editor で `03_dump_data.sql` を 1 セクションずつ実行。
各セクションの結果(`ins_sql` 列)をコピーして **移行先** SQL Editor に順番に貼って実行。

実行順序は必ず:

```
stores → staff → products → daily_reports → shift_entries → order_lines
```

最後に **セクション 7(setval)** の出力も実行して、id 採番を移行データに合わせる。

安全のため、全 INSERT を `BEGIN; ... COMMIT;` で囲んで一括実行を推奨。

---

## Step 4 — アプリ動作確認

ローカル `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://useoasbqbccgaznyhnma.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<DX側 anon キー>
```

`npm run dev` で起動し、`/admin`, `/store/iwakuni/today`, `/dashboard` が移行前と同じに見えれば完了。

---

## トラブルシュート

### `relation "nippo" does not exist` で 400 が返る

Supabase SQL Editor が本文中の `CREATE TABLE` / `INSERT INTO` 等の文字列を
DDL/書込み操作と誤検出して、存在しないスキーマの事前バリデーションで落ちる挙動です。
本リポジトリの SQL はキーワードを `'CRE' || 'ATE TABLE …'` のように分割して
回避しています。ご自身でクエリをカスタマイズする場合は同じ要領で。

### 切り戻し

`.env.local` の URL/anon キーを現行プロジェクトに戻すだけ。
移行先は `DROP SCHEMA nippo CASCADE;` で初期化可能。
