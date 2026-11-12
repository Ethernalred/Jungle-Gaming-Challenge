export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}
export class CurrencyMismatchError extends DomainError {}
export class InsufficientBalanceError extends DomainError {}
export class InvalidLedgerEntryError extends DomainError {}
export class WalletAlreadyExistsError extends DomainError {}
export class NotFoundError extends DomainError {}
export class ValidationError extends DomainError {}
export class InvalidTransactionStateError extends DomainError {}
export class IdempotencyConflictError extends DomainError {}
export class ExternalIdConflictError extends DomainError {}
export class WalletNotFoundError extends DomainError {}
export class WalletPlayerMismatchError extends DomainError {}
/** Transient infrastructure failure (DB down, lock timeout): the caller may resend. */
export class TransientError extends DomainError {}
