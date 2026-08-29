'use client';
import { AttendanceAdmin } from '@/components/admin/AttendanceAdmin';

export default function AttendancePage() {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="font-mincho text-3xl font-extrabold">勤怠管理</h1>
        <p className="text-xs text-muted font-mono mt-1 tracking-wider">ATTENDANCE · TIME CLOCK</p>
      </div>
      <AttendanceAdmin />
    </div>
  );
}
