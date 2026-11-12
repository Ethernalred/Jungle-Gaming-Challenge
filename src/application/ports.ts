import { IntegrationEvent } from '../domain/events/integration-event';
import { WalletLedgerEntry } from '../domain/ledger-entry';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';

export interface OpeningWager { transactionId: string; entry: WalletLedgerEntry; events: IntegrationEvent<any>[] }

export abstract class WalletRepository {
  /** One DB transaction: the Wallet, and (when given) its OPENING Wager Transaction + Ledger Entry. Throws WalletAlreadyExistsError. */
  abstract open(wallet: Wallet, opening?: OpeningWager): Promise<void>;
  abstract find(id: string): Promise<Wallet | null>;
  /** Ledger Entries ordered by (createdAt, id), strictly after `after`. */
  abstract ledgerPage(walletId: string, after: { createdAt: Date; id: string } | null, limit: number): Promise<WalletLedgerEntry[]>;
  /** One DB transaction holding FOR SHARE on the Wallet: stored Balance vs signed sum of its Ledger Entries. Null when the Wallet is unknown. */
  abstract reconcile(walletId: string): Promise<{ stored: Money; calculated: Money; checkedEntries: number } | null>;
}
