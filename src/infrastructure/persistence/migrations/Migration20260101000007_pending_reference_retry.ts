import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000007_pending_reference_retry extends Migration {
  override async up(): Promise<void> {
    // D27: attempts counts worker retries; next_attempt_at null = first retry due created_at + 2 s.
    this.addSql('alter table wager_transactions add column reference_attempts int not null default 0, add column next_attempt_at timestamptz');
    this.addSql(`create index wager_transactions_pending_idx on wager_transactions (coalesce(next_attempt_at, created_at)) where status = 'PENDING_REFERENCE'`);
  }

  override async down(): Promise<void> {
    this.addSql('drop index wager_transactions_pending_idx');
    this.addSql('alter table wager_transactions drop column reference_attempts, drop column next_attempt_at');
  }
}
