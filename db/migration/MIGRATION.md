# DB 移行手順 — 現行 Supabase → DXシステム側 Supabase (`nippo` スキーマ)

このドキュメントは、現行の日報システム DB(`public` スキーマ)を、
DXシステム側 Supabase プロジェクトの `nippo` スキーマに丸ごと移すための手順書です。
すべて Supabase Dashboard の **SQL Editor** だけで完結します。

---

## 0. 移行先プロジェクト情報

- URL: `https://useoasbqbccgaznyhnma.supabase.co`
- anon キー: Dashboard → Project Settings → API から取得し、ローカル `.env.local` に貼る(リポジトリにはコミットしません)

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

### 2-A. 推奨: 移行元の "Definition" タブからコピー

1. 移行元 Dashboard → **Database → Tables** を開く
2. 各テーブル(`stores`, `staff`, `products`, `daily_reports`, `shift_entries`, `order_lines`)を選択し、上部 **"Definition"** タブの CREATE TABLE 文をコピー
3. テキストエディタで `public.` → `nippo.` に置換
4. 移行先 SQL Editor に貼り付けて実行

### 2-B. 雛形を使う場合

`db/migration/03_schema_template.sql` をベースに不足分(インデックス・制約・トリガ・RLS)を追記して実行。
**これはコードから推測した雛形なので、必ず 2-A で得た正本と突き合わせてください。**

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
