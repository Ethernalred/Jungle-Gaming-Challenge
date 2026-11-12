import { EntitySchema } from '@mikro-orm/postgresql';

// Row shapes: plain data, no behaviour. Amounts are decimal strings (ADR-0001).
export class WalletRow {
  id!: string; playerId!: string; currency!: string; balance!: string;
  version!: number; createdAt!: Date; updatedAt!: Date;
}
export const WalletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'string', columnType: 'numeric(19,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', fieldName: 'updated_at', columnType: 'timestamptz' },
  },
});

export class LedgerEntryRow {
  id!: string; walletId!: string; transactionId!: string; direction!: string; amount!: string;
  currency!: string; balanceBefore!: string; balanceAfter!: string; createdAt!: Date;
}
export const LedgerEntrySchema = new EntitySchema<LedgerEntryRow>({
  class: LedgerEntryRow,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'string', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'string', fieldName: 'balance_before', columnType: 'numeric(19,2)' },
    balanceAfter: { type: 'string', fieldName: 'balance_after', columnType: 'numeric(19,2)' },
    createdAt: { type: 'Date', fieldName: 'created_at', columnType: 'timestamptz' },
  },
});
