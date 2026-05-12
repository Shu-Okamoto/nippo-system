'use client';
import { useState, useEffect } from 'react';

export function NumInput({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  const [text, setText] = useState(value !== null ? value.toLocaleString('ja-JP') : '');

  useEffect(() => {
    setText(value !== null ? value.toLocaleString('ja-JP') : '');
  }, [value]);

  const handleChange = (s: string) => {
    const digits = s.replace(/[^\d]/g, '');
    setText(digits ? Number(digits).toLocaleString('ja-JP') : '');
    onChange(digits ? Number(digits) : null);
  };

  return (
    <div className="mb-3">
      <label className="block text-xs font-bold mb-1.5 text-muted">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          className="flex-1 px-3 py-3 text-xl font-bold border-2 border-ink bg-paper font-mono text-right"
        />
        <span className="text-sm font-bold text-muted min-w-[24px]">{unit}</span>
      </div>
    </div>
  );
}
