'use client';
import { useState } from 'react';
import type { Product } from '@/lib/types';

export function AddOrderRow({
  products,
  usedProductIds,
  ownProducts,
  onAddFromMaster,
  onAddManual,
  onToggleOwnProduct,
}: {
  products: Product[];
  usedProductIds: number[];
  // 自店が追加した商品(停止中も含む)。停止/復帰できるのはこれだけ。
  // 本部の編集画面(PastReportEditor)では渡さない。商品マスタで管理するため
  ownProducts?: Product[];
  onAddFromMaster: (productId: number) => void;
  // registerToMaster=true なら商品マスタにも登録する
  onAddManual: (name: string, registerToMaster: boolean) => void;
  onToggleOwnProduct?: (productId: number, nextActive: boolean) => void;
}) {
  const [manualMode, setManualMode] = useState(false);
  const [manualName, setManualName] = useState('');
  const [registerToMaster, setRegisterToMaster] = useState(false);

  // 停止中の商品も products に入っている(注文行の商品名を引くため)。
  // セレクトには出さない
  const available = products.filter((p) => p.is_active && !usedProductIds.includes(p.id));

  if (manualMode) {
    return (
      <div className="p-3 border-t-2 border-ink bg-paper2 space-y-2">
        <input
          type="text"
          value={manualName}
          placeholder="臨時商品名(例: 新生姜)"
          onChange={(e) => setManualName(e.target.value)}
          className="w-full p-2 border-2 border-ink bg-paper text-sm"
        />
        <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
          <input
            type="checkbox"
            checked={registerToMaster}
            onChange={(e) => setRegisterToMaster(e.target.checked)}
            className="w-4 h-4"
          />
          商品マスタにも登録する(次回からセレクトに表示)
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => {
              if (manualName.trim()) {
                onAddManual(manualName.trim(), registerToMaster);
                setManualName('');
                setRegisterToMaster(false);
                setManualMode(false);
              }
            }}
            className="flex-1 px-3 py-2 bg-ink text-paper border-2 border-ink font-bold text-xs"
          >
            追加
          </button>
          <button
            onClick={() => {
              setManualMode(false);
              setManualName('');
              setRegisterToMaster(false);
            }}
            className="px-3 py-2 bg-paper border-2 border-ink font-bold text-xs"
          >
            戻る
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-2 p-3 border-t-2 border-ink bg-paper2">
        <select
          defaultValue=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) {
              onAddFromMaster(Number(v));
              e.target.value = '';
            }
          }}
          className="flex-1 p-2 border-2 border-ink bg-paper text-sm min-w-0"
        >
          <option value="">＋ 商品追加(マスタ)</option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.category} / {p.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setManualMode(true)}
          className="px-3 py-2 bg-ink text-paper border-2 border-ink font-bold text-xs whitespace-nowrap"
        >
          臨時商品
        </button>
      </div>

      {ownProducts && onToggleOwnProduct && (
        <OwnProducts products={ownProducts} onToggle={onToggleOwnProduct} />
      )}
    </>
  );
}

/**
 * 自店が日報から追加した商品の停止/復帰。
 * 本部が登録した商品はここに出ない(停止は本部でしかできない)
 */
function OwnProducts({
  products,
  onToggle,
}: {
  products: Product[];
  onToggle: (productId: number, nextActive: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  if (products.length === 0) return null;

  const stopped = products.filter((p) => !p.is_active).length;

  return (
    <div className="border-t-2 border-ink bg-paper">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs font-bold">
          自店で追加した商品
          <span className="ml-1.5 font-mono text-[11px] text-muted">
            {products.length}件{stopped > 0 ? ` (停止中${stopped})` : ''}
          </span>
        </span>
        <span className="font-mono text-xs text-muted">{open ? '閉じる ▲' : '管理 ▼'}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          <p className="text-[11px] text-muted leading-relaxed">
            使わなくなった商品は停止できます。停止すると商品追加のセレクトに出なくなります。
            過去の注文履歴は残ります。
          </p>
          {products.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-2 border-ink bg-paper2"
            >
              <span className={`text-sm font-bold ${p.is_active ? '' : 'text-muted line-through'}`}>
                {p.name}
              </span>
              <button
                onClick={() => onToggle(p.id, !p.is_active)}
                className={`px-2.5 py-1 border-2 border-ink font-bold text-xs whitespace-nowrap ${
                  p.is_active ? 'bg-paper text-accent' : 'bg-ink text-paper'
                }`}
              >
                {p.is_active ? '停止' : '復帰'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
