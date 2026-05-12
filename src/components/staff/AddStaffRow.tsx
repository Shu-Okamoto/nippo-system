'use client';
import { useState } from 'react';
import type { Staff } from '@/lib/types';

export function AddStaffRow({
  staffList,
  usedStaffIds,
  onAddFromMaster,
  onAddManual,
}: {
  staffList: Staff[];
  usedStaffIds: number[];
  onAddFromMaster: (staffId: number) => void;
  onAddManual: (name: string) => void;
}) {
  const [manualMode, setManualMode] = useState(false);
  const [manualName, setManualName] = useState('');

  const available = staffList.filter((s) => !usedStaffIds.includes(s.id));

  if (manualMode) {
    return (
      <div className="flex gap-2 p-3 border-t-2 border-ink bg-paper2">
        <input
          type="text"
          value={manualName}
          placeholder="氏名(例: 姪)"
          onChange={(e) => setManualName(e.target.value)}
          className="flex-1 p-2 border-2 border-ink bg-paper text-sm"
        />
        <button
          onClick={() => {
            if (manualName.trim()) {
              onAddManual(manualName.trim());
              setManualName('');
              setManualMode(false);
            }
          }}
          className="px-3 py-2 bg-ink text-paper border-2 border-ink font-bold text-xs"
        >
          追加
        </button>
        <button
          onClick={() => setManualMode(false)}
          className="px-3 py-2 bg-paper border-2 border-ink font-bold text-xs"
        >
          戻る
        </button>
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
        className="flex-1 p-2 border-2 border-ink bg-paper text-sm"
      >
        <option value="">＋ スタッフ追加(マスタ)</option>
        {available.map((s) => (
          <option key={s.id} value={s.id}>
            {s.role === 'head' ? '店責: ' : ''}
            {s.name}
          </option>
        ))}
      </select>
      <button
        onClick={() => setManualMode(true)}
        className="px-3 py-2 bg-ink text-paper border-2 border-ink font-bold text-xs whitespace-nowrap"
      >
        手入力
      </button>
    </div>
  );
}
