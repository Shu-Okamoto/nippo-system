-- ============================================================
-- 店舗が自分で追加した商品を、自分で停止できるようにする
-- ------------------------------------------------------------
-- 日報の「本部への注文」で臨時商品を「商品マスタにも登録する」と
-- 追加できるが、不要になっても店舗側では消せず本部に頼むしかない。
--
-- products にはこれまで「誰が追加したか」が無かったので、
-- 追加した店舗を記録する列を足し、その店舗だけが停止/復帰できる
-- RPC を用意する。
--
--   created_by_store_id IS NULL … 本部が登録した商品(店舗は触れない)
--   created_by_store_id = 自店   … 自分で追加した商品(停止/復帰できる)
--
-- 既存の商品はすべて NULL になる。この変更より前に店舗が追加した
-- 商品も本部扱いのままなので、停止が必要なら本部の商品マスタで行う。
--
-- 既存の add_product() はそのまま残す(本文が移行元からの
-- ダンプで、ここでは触らない)。店舗側は add_store_product() に移す。
--
-- 実行場所: 移行先(DX側) SQL Editor で1回
-- 前提: 01_setup_target.sql 実行済み
-- ============================================================


-- ------------------------------------------------------------
-- (1) 追加した店舗を記録する列
--     店舗を消しても商品は残すので ON DELETE SET NULL
-- ------------------------------------------------------------
ALTER TABLE nippo.products
  ADD COLUMN IF NOT EXISTS created_by_store_id integer
    REFERENCES nippo.stores(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS products_created_by_store_idx
  ON nippo.products (created_by_store_id);


-- ------------------------------------------------------------
-- (2) 店舗からの商品マスタ登録
--     同名の商品があれば作り直さず、それを返す。
--     自店が停止していた商品なら復帰させる(停止→再追加で
--     同じ名前が二重に並ばないようにする)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.add_store_product(
  p_slug     text,
  p_name     text,
  p_category text DEFAULT 'その他'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
  v_name     text := NULLIF(btrim(COALESCE(p_name, '')), '');
  v_cat      text := COALESCE(NULLIF(btrim(COALESCE(p_category, '')), ''), 'その他');
  v_row      nippo.products;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION '商品名を入力してください';
  END IF;

  IF length(v_name) > 100 THEN
    RAISE EXCEPTION '商品名が長すぎます';
  END IF;

  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  SELECT * INTO v_row
  FROM nippo.products
  WHERE name = v_name
  ORDER BY is_active DESC, id
  LIMIT 1;

  IF v_row.id IS NOT NULL THEN
    -- 自店が停止した商品なら戻す。本部の商品や他店の商品は触らない
    IF NOT v_row.is_active AND v_row.created_by_store_id = v_store_id THEN
      UPDATE nippo.products
         SET is_active = true
       WHERE id = v_row.id
      RETURNING * INTO v_row;
    ELSIF NOT v_row.is_active THEN
      -- 本部が停止した商品。勝手に復活させず、理由が分かるように弾く
      RAISE EXCEPTION '「%」は本部が停止している商品です。本部に連絡してください', v_name;
    END IF;

    RETURN to_jsonb(v_row);
  END IF;

  INSERT INTO nippo.products (name, category, sort_order, is_active, created_by_store_id)
  VALUES (
    v_name,
    v_cat,
    COALESCE((SELECT max(sort_order) FROM nippo.products), 0) + 1,
    true,
    v_store_id
  )
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.add_store_product(text, text, text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (3) その店舗が追加した商品の一覧(停止中も含む)
--     停止したものを戻せるよう、停止中も返す
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.get_store_products(
  p_slug text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.is_active DESC, p.sort_order, p.id), '[]'::jsonb)
    FROM nippo.products p
    WHERE p.created_by_store_id = v_store_id
  );
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.get_store_products(text)
  TO anon, authenticated, service_role;


-- ------------------------------------------------------------
-- (4) 停止 / 復帰。自店が追加した商品だけ
--     本部の商品や他店の商品は「権限がありません」で弾く
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION nippo.set_store_product_active(
  p_slug       text,
  p_product_id integer,
  p_active     boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = nippo, public
AS $func$
DECLARE
  v_store_id int;
  v_owner    int;
  v_row      nippo.products;
BEGIN
  SELECT id INTO v_store_id
  FROM nippo.stores
  WHERE slug = p_slug AND is_active;

  IF v_store_id IS NULL THEN
    RAISE EXCEPTION '店舗が見つかりません: %', p_slug;
  END IF;

  SELECT created_by_store_id INTO v_owner
  FROM nippo.products WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '商品が見つかりません';
  END IF;

  IF v_owner IS NULL OR v_owner <> v_store_id THEN
    RAISE EXCEPTION 'この商品は本部で管理しています。本部に連絡してください';
  END IF;

  UPDATE nippo.products
     SET is_active = COALESCE(p_active, false)
   WHERE id = p_product_id
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$func$;

GRANT EXECUTE ON FUNCTION nippo.set_store_product_active(text, integer, boolean)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
