'use client';
import { useState } from 'react';
import type { Product } from '@/lib/types';

export function AddOrderRow({
  products,
  usedProductIds,
  onAddFromMaster,
  onAddManual,
}: {
  products: Product[];
  usedProductIds: number[];
  onAddFromMaster: (productId: number) => void;
  // registerToMaster=true なら商品マスタにも登録する
  onAddManual: (name: string, registerToMaster: boolean) => void;
}) {
  const [manualMode, setManualMode] = useState(false);
  const [manualName, setManualName] = useState('');
  const [registerToMaster, setRegisterToMaster] = useState(false);

  const available = products.filter((p) => !usedProductIds.includes(p.id));

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
  );
}
