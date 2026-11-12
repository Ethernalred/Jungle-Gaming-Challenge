import { Migration } from '@mikro-orm/migrations';

// D17: the running app connects as jungle_app (no UPDATE/DELETE on wallet_ledger_entries); migrations stay on the owner.
// Dev-only password, same spirit as the compose `jungle` one.
export class Migration20260101000004_app_role_login extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter role jungle_app login password 'jungle_app'`);
    this.addSql('grant select, insert, update on wallets, wager_transactions to jungle_app');
    this.addSql('grant select, insert on wallet_ledger_entries to jungle_app');
    this.addSql('grant usage, select on all sequences in schema public to jungle_app');
    // Applies to tables later migrations create as the owner; the ledger already exists, so it keeps select/insert only.
    this.addSql('alter default privileges in schema public grant select, insert, update, delete on tables to jungle_app');
    this.addSql('alter default privileges in schema public grant usage, select on sequences to jungle_app');
  }

  override async down(): Promise<void> {
    this.addSql('alter default privileges in schema public revoke usage, select on sequences from jungle_app');
    this.addSql('alter default privileges in schema public revoke select, insert, update, delete on tables from jungle_app');
    this.addSql('revoke usage, select on all sequences in schema public from jungle_app');
    this.addSql('alter role jungle_app nologin password null');
  }
}
