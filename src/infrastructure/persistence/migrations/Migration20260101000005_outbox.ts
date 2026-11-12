import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000005_outbox extends Migration {
  override async up(): Promise<void> {
    // seq keeps insertion order for the publisher; event_id (= id) is the SQS deduplication id.
    this.addSql(`create table outbox_events (
      seq bigserial primary key,
      id uuid not null unique,
      aggregate_id uuid not null,
      event_type text not null,
      payload jsonb not null,
      created_at timestamptz not null,
      published_at timestamptz,
      attempts int not null default 0,
      next_attempt_at timestamptz not null default now()
    )`);
    this.addSql('create index outbox_events_unpublished_idx on outbox_events (next_attempt_at, seq) where published_at is null');
    this.addSql('grant select, insert, update, delete on outbox_events to jungle_app'); // 0004 default privileges cover this; explicit for fresh roles
    this.addSql('grant usage, select on sequence outbox_events_seq_seq to jungle_app');
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_events');
  }
}
