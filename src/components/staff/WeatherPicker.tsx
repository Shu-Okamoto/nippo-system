'use client';
import type { Weather } from '@/lib/types';

const OPTIONS: { key: Weather; emoji: string }[] = [
  { key: 'sunny', emoji: '☀️' },
  { key: 'cloudy', emoji: '☁️' },
  { key: 'rainy', emoji: '☂️' },
  { key: 'snowy', emoji: '❄️' },
];

export function WeatherPicker({
  value,
  onChange,
}: {
  value: Weather | null;
  onChange: (v: Weather) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`aspect-square border-2 border-ink text-3xl flex items-center justify-center transition-all ${
            value === o.key ? 'bg-ink translate-x-[-2px] translate-y-[-2px] shadow-inkSm' : 'bg-paper hover:bg-paper2'
          }`}
        >
          {o.emoji}
        </button>
      ))}
    </div>
  );
}
