// Static migration list (ADR-0004/D2): every migration is imported and listed here, no globs.
import { Migration20260101000003_wallet_ledger } from './Migration20260101000003_wallet_ledger';
import { Migration20260101000004_app_role_login } from './Migration20260101000004_app_role_login';
import { Migration20260101000005_outbox } from './Migration20260101000005_outbox';
import { Migration20260101000006_inbox } from './Migration20260101000006_inbox';
import { Migration20260101000007_pending_reference_retry } from './Migration20260101000007_pending_reference_retry';

export const migrationsList: { name: string; class: any }[] = [
  { name: 'Migration20260101000003_wallet_ledger', class: Migration20260101000003_wallet_ledger },
  { name: 'Migration20260101000004_app_role_login', class: Migration20260101000004_app_role_login },
  { name: 'Migration20260101000005_outbox', class: Migration20260101000005_outbox },
  { name: 'Migration20260101000006_inbox', class: Migration20260101000006_inbox },
  { name: 'Migration20260101000007_pending_reference_retry', class: Migration20260101000007_pending_reference_retry },
];
