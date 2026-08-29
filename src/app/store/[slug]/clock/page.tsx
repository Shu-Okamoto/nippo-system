import { TimeClock } from '@/components/staff/TimeClock';

export default function ClockPage({ params }: { params: { slug: string } }) {
  return <TimeClock slug={params.slug} />;
}
