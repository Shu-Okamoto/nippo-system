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
  // freee人事労務の従業員ID。未設定なら打刻は freee に送られない
  freee_employee_id: number | null;
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

export type ReportInputType = 'text' | 'textarea' | 'number' | 'checkbox';

export type ReportQuestion = {
  id: number;
  question: string;
  input_type: ReportInputType;
  sort_order: number;
  is_active: boolean;
  initial_value: string | null;
};

// 勤怠打刻
export type ClockEventType = 'clock_in' | 'break_begin' | 'break_end' | 'clock_out';

// 打刻画面で使う「そのメンバーの今の状態」。none = 未出勤
export type ClockState = ClockEventType | 'none';

export type ClockMember = {
  staff_id: number;
  name: string;
  role: StaffRole;
  sort_order: number;
  work_date: string;
  // PIN 未設定のメンバーは打刻できない(管理画面で発行が必要)
  has_pin: boolean;
  last_event: ClockState;
  clock_in_at: string | null;
  clock_out_at: string | null;
  break_minutes: number | null;
};

// スタッフマスタの非公開情報。PIN ハッシュは返らない
export type StaffPrivate = {
  staff_id: number;
  has_pin: boolean;
  pin_set_at: string | null;
  locked: boolean;
  hourly_wage: number | null;
};

export type ClockBoard = {
  store_name: string;
  today: string;
  server_time: string;
  // 全体設定。false なら PIN 入力なしで打刻できる
  require_pin: boolean;
  members: ClockMember[];
};

export type ReportAnswer = {
  id: number;
  daily_report_id: number;
  question_id: number;
  answer_text: string | null;
};
