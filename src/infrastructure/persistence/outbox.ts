import type { EntityManager } from '@mikro-orm/postgresql';
import { IntegrationEvent } from '../../domain/events/integration-event';

/** The one outbox writer: call inside the DB transaction of the change (same `em`). */
export async function writeOutbox(em: EntityManager, events: IntegrationEvent<any>[]): Promise<void> {
  if (!events.length) return;
  const values = events.map(() => '(?, ?, ?, ?::jsonb, ?)').join(', ');
  await em.execute(
    `insert into outbox_events (id, aggregate_id, event_type, payload, created_at) values ${values}`,
    events.flatMap((e) => [e.eventId, e.aggregateId, e.eventType, JSON.stringify(e), e.occurredAt]),
  );
}
