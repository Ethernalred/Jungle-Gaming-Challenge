import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000006_inbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table inbox (
      consumer_name text not null,
      message_id text not null,
      payload_hash text not null,
      received_at timestamptz not null default now(),
      primary key (consumer_name, message_id)
    )`);
    this.addSql('grant select, insert, update, delete on inbox to jungle_app');
  }

  override async down(): Promise<void> {
    this.addSql('drop table inbox');
  }
}
