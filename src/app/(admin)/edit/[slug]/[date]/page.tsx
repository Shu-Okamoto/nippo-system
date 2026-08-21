import { PastReportEditor } from '@/components/admin/PastReportEditor';

export default function EditPastReportPage({
  params,
}: {
  params: { slug: string; date: string };
}) {
  return <PastReportEditor slug={params.slug} date={params.date} />;
}
