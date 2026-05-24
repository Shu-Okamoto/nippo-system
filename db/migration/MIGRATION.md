# DB 移行手順 — 現行 Supabase → DXシステム側 Supabase (`nippo` スキーマ)

このドキュメントは、現行の日報システム DB(`public` スキーマ)を、
DXシステム側 Supabase プロジェクトの `nippo` スキーマに丸ごと移すための手順書です。
すべて Supabase Dashboard の **SQL Editor** だけで完結します。

---

## 0. 移行先プロジェクト情報

- URL: `https://useoasbqbccgaznyhnma.supabase.co`
- anon キー: Dashboard → Project Settings → API から取得し、ローカル `.env.local` に貼る(リポジトリにはコミットしません)

---

## ⚠ Supabase SQL Editor の DDL 検出について

Supabase SQL Editor は、クエリ本文に `CREATE TABLE` / `ALTER TABLE` / `INSERT INTO`
等のキーワードが **文字列リテラル内であっても** 含まれていると、テキストスキャンで
DDL/書き込み操作と誤検出し、`relation "nippo" does not exist`(400)を返すことが
あります。本リポジトリの SQL は、これを回避するためキーワードを文字列連結で分割
しています(例: `'CRE' || 'ATE TABLE …'`)。出力結果は通常の DDL/INSERT 文です。

ご自身でクエリをカスタマイズする場合は、SELECT 内に DDL キーワードのリテラルを
そのまま書かないよう注意してください。

---

## 1. 移行先プロジェクトの初期化

移行先 Dashboard の **SQL Editor** で以下を 1 回実行:

```
db/migration/01_target_init.sql
```

- `nippo` スキーマを作成
- `anon` / `authenticated` / `service_role` に必要権限を付与

実行後、Dashboard → **Project Settings → API → Exposed schemas** に `nippo` を追加。
(`public` のままだと PostgREST から見えません)

---

## 2. テーブル DDL を移行先で作成

### 2-A. 推奨: SQL Editor で本物の DDL を自動出力する

移行元 Dashboard → **SQL Editor** で `db/migration/02b_dump_tables.sql` を実行。
結果として以下が一覧で出てきます(すべて `public.` → `nippo.` 置換済み):

1. `CREATE TABLE IF NOT EXISTS nippo.xxx (...)` × 6 テーブル
2. `ALTER TABLE nippo.xxx ADD CONSTRAINT ...` (PK / UNIQUE / FK / CHECK)
3. ユーザー定義インデックス

`ddl` カラムを上から順に全選択してコピー、移行先 SQL Editor に貼って実行。

> **トリガが現行にある場合**: `02b_dump_tables.sql` 末尾の補足クエリでトリガ定義も
> 取得できます。トリガが参照する関数は `02_dump_source.sql` で出る関数ダンプに
> 含まれているか確認(無ければ関数名を WHERE 句に追加)。

### 2-B. 雛形(参考)

`db/migration/03_schema_template.sql` はコードから推測したテーブル雛形です。
2-A が使えれば不要ですが、現行 DB に接続できない状況や、ゼロから組み直す場合の
比較用に残しています。

---

## 3. View / RPC を移行先で作成

移行元 SQL Editor で以下を実行し、結果の SQL をコピー:

```
db/migration/02_dump_source.sql
```

これは以下を出力します:

- `nippo.daily_kpi` ビュー定義(`public.` を `nippo.` に置換済み)
- RPC 関数定義4本(`get_today_full`, `save_daily_report_full`, `add_product`, `get_orders_for_pdf`)
- 既存の RLS ポリシー一覧(参考表示)

出力された DDL をコピーして移行先 SQL Editor で実行。

### RLS について

3本目のクエリで現行 RLS ポリシーが見えます。同じポリシーを `nippo` スキーマ上で
貼り直すかは運用方針次第:

- **店舗画面(`/store/[slug]/today`)** は未ログイン運用 → `anon` ロールに SELECT/INSERT/UPDATE が必要
- **本部画面(`/dashboard`, `/admin`)** は要ログイン → `authenticated` のみ書き込みを許可するポリシー推奨

---

## 4. データ移行

### 4-1. 移行元から INSERT 文を出力

移行元 SQL Editor で `db/migration/04_dump_data.sql` を 1 セクションずつ実行。
各クエリ結果の `sql` カラムを全選択コピー(右上のダウンロードボタンで CSV 化して
Excel/エディタで結合してもよい)。

### 4-2. 移行先で INSERT を実行

移行先 SQL Editor に貼り、`BEGIN; ... COMMIT;` で囲んで一括実行を推奨:

```sql
BEGIN;
-- stores
INSERT INTO nippo.stores ...
-- staff
INSERT INTO nippo.staff ...
-- (中略)
-- order_lines
INSERT INTO nippo.order_lines ...
-- シーケンス補正(04_dump_data.sql の 7) 出力)
SELECT setval(...);
COMMIT;
```

実行順序は必ず `stores → staff → products → daily_reports → shift_entries → order_lines`。
最後にシーケンス補正の `setval(...)` 6 行を実行(以降の INSERT で id 衝突を防ぐため)。

---

## 5. アプリ側の切替

ローカル `.env.local` を以下に書き換え:

```env
NEXT_PUBLIC_SUPABASE_URL=https://useoasbqbccgaznyhnma.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<DXシステム側の anon キー>
```

`src/lib/supabase.ts` 側で `db: { schema: 'nippo' }` を指定する変更は同コミットで適用済み。
これで `supabase.from('stores')` などはすべて `nippo.stores` を参照します。

`npm run dev` でアプリを起動し、以下を確認:

- `/admin` → 店舗・スタッフ・商品マスタが移行前と同じに見える
- `/store/iwakuni/today` → 既存日報があれば復元される
- `/dashboard` → 当日 KPI が移行前と同じ

---

## 6. 切り戻し

不具合時は `.env.local` の URL/anon キーを現行プロジェクトに戻すだけ。
移行先 `nippo` スキーマは DROP SCHEMA nippo CASCADE; で初期化可能。
