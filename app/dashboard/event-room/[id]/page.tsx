import { notFound } from 'next/navigation';
import { getEventRoomData, getEventsList } from '@/actions/eventRoomActions';
import EventRoomClient from './EventRoomClient';

interface Props { params: Promise<{ id: string }> }

export default async function EventRoomPage({ params }: Props) {
  const { id } = await params;
  const [data, events] = await Promise.all([
    getEventRoomData(id),
    getEventsList({ limit: 100 }),
  ]);
  if (!data.success) notFound();
  return <EventRoomClient initial={data} initialEvents={events} eventId={id} />;
}
