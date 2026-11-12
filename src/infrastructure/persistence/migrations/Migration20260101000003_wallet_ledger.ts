import { Migration } from '@mikro-orm/migrations';

export class Migration20260101000003_wallet_ledger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(19,2) not null,
        version int not null default 1,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_player_currency_unique unique (player_id, currency)
      )`);

    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null,
        payload_hash text not null,
        player_id uuid not null,
        wallet_id uuid not null references wallets(id),
        round_id text,
        game_id text,
        kind text not null,
        status text not null,
        failure_code text,
        amount numeric(19,2) not null,
        currency char(3) not null,
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions(id),
        balance_snapshot numeric(19,2),
        processed_at timestamptz,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wager_transactions_kind_check check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_transactions_status_check check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_transactions_amount_check check (amount > 0 or (kind = 'LOSS' and amount = 0)),
        constraint wager_transactions_opening_provider_check check (kind <> 'OPENING' or provider_id = 'internal'),
        constraint wager_transactions_opening_ids_check check (kind <> 'OPENING'
          or (external_transaction_id = 'opening:' || wallet_id::text and idempotency_key = external_transaction_id)),
        constraint wager_transactions_round_game_check check (kind = 'OPENING' or (round_id is not null and game_id is not null)),
        constraint wager_transactions_balance_snapshot_check check (balance_snapshot is null or balance_snapshot >= 0),
        constraint wager_transactions_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_transactions_external_id_unique unique (provider_id, external_transaction_id)
      )`);
    // D8: a Wager Transaction has at most one Processed Reversal (REFUND or ROLLBACK).
    this.addSql(`
      create unique index wager_transactions_one_reversal
        on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')`);
    this.addSql('create index wager_transactions_wallet_idx on wager_transactions (wallet_id)');

    this.addSql(`
      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction text not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null,
        constraint ledger_direction_check check (direction in ('DEBIT','CREDIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_arithmetic_check check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)),
        constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id)
      )`);
    this.addSql('create index ledger_wallet_page_idx on wallet_ledger_entries (wallet_id, created_at, id)');
    this.addSql(`
      create function wallet_ledger_entries_immutable() returns trigger language plpgsql as $$
      begin raise exception 'wallet_ledger_entries are immutable'; end $$`);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_immutable()`);

    // Least-privilege role: Ledger Entries are insert/select only (D17). NOLOGIN; use with SET ROLE.
    this.addSql(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'jungle_app') then create role jungle_app nologin; end if;
    end $$`);
    this.addSql('grant select, insert, update on wallets, wager_transactions to jungle_app');
    this.addSql('grant select, insert on wallet_ledger_entries to jungle_app');
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists wallet_ledger_entries');
    this.addSql('drop function if exists wallet_ledger_entries_immutable()');
    this.addSql('drop table if exists wager_transactions');
    this.addSql('drop table if exists wallets');
    this.addSql(`do $$ begin
      if exists (select 1 from pg_roles where rolname = 'jungle_app') then drop owned by jungle_app; drop role jungle_app; end if;
    end $$`);
  }
}
