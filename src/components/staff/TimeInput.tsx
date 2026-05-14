'use client';
import { useState, useEffect } from 'react';

// HH:MM形式に正規化できるか試みる
function tryNormalize(s: string): string | null {
  // 数字4桁のみ入力(例: 0900 → 09:00, 1300 → 13:00)
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length === 4) {
    const h = Number(digits.slice(0, 2));
    const m = Number(digits.slice(2));
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  }
  // コロン区切り入力(例: 9:00, 13:00)
  const m = s.match(/^(\d{1,2})[:：](\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }
  }
  return null;
}

export function TimeInput({
  value,
  onChange,
  placeholder = '9:00',
  className = '',
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value ? value.slice(0, 5) : '');

  useEffect(() => {
    setText(value ? value.slice(0, 5) : '');
  }, [value]);

  const handleChange = (s: string) => {
    setText(s);
    // 正規化できる形式になった時点で即時通知(スマホ完了ボタン対応)
    const normalized = tryNormalize(s);
    if (normalized) {
      onChange(normalized);
    }
  };

  const handleBlur = () => {
    if (!text) {
      onChange(null);
      return;
    }
    const normalized = tryNormalize(text);
    if (normalized) {
      setText(normalized);
      onChange(normalized);
    } else {
      // 正規化できない場合はリセット
      setText(value ? value.slice(0, 5) : '');
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      placeholder={placeholder}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={handleBlur}
      className={`px-3 py-2 font-mono text-base font-bold text-center border-2 border-ink bg-paper ${className}`}
    />
  );
}
