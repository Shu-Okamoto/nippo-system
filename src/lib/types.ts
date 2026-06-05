export type Weather = 'sunny' | 'cloudy' | 'rainy' | 'snowy';
export type ShiftPattern = 'first' | 'last' | 'through';
export type EntryType = 'plan' | 'actual';
export type StaffRole = 'head' | 'part' | 'support';

export type Store = {
  id: number;
  name: string;
  slug: string;
  open_time: string;
  close_time: string;
  is_active: boolean;
};

export type Staff = {
  id: number;
  store_id: number;
  name: string;
  role: StaffRole;
  sort_order: number;
  is_active: boolean;
};

export type Product = {
  id: number;
  name: string;
  category: string;
  sort_order: number;
  is_active: boolean;
};

export type DailyReport = {
  id: number;
  store_id: number;
  report_date: string;
  weather: Weather | null;
  event_note: string | null;
  sales_forecast: number | null;
  sales_actual: number | null;
  customer_count: number | null;
  sozai_zan: string | null;
  mochi_zan: string | null;
  report_text: string | null;
  kizuki: string | null;
  bikou: string | null;
};

export type ShiftEntry = {
  id: number;
  daily_report_id: number;
  staff_id: number | null;
  staff_name_manual: string | null;
  entry_type: EntryType;
  pattern: ShiftPattern | null;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  break_start: string | null;
  break_end: string | null;
};

export type OrderLine = {
  id: number;
  daily_report_id: number;
  product_id: number | null;
  item_name_manual: string | null;
  planned_qty: number;
  actual_qty: number;
};
