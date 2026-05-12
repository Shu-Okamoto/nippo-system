'use client';
import { useState, useEffect } from 'react';

// HH:MM(またはH:MM)文字列を正規化
function normalize(s: string): string {
  const m = s.match(/^(\d{1,2})[:：]?(\d{0,2})$/);
  if (!m) return s;
  const h = Number(m[1]);
  const min = Number(m[2] || '0');
  if (isNaN(h) || isNaN(min)) return s;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
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
  const [text, setText] = useState(value || '');

  useEffect(() => {
    setText(value ? value.slice(0, 5) : '');
  }, [value]);

  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (!text) {
          onChange(null);
        } else {
          const n = normalize(text);
          setText(n);
          onChange(n);
        }
      }}
      className={`px-3 py-2 font-mono text-base font-bold text-center border-2 border-ink bg-paper ${className}`}
    />
  );
}
