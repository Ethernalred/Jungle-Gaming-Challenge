import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import {
  ExternalIdConflictError, IdempotencyConflictError, InvalidMoneyError, NotFoundError, TransientError, ValidationError,
  WalletAlreadyExistsError, WalletNotFoundError, WalletPlayerMismatchError,
} from '../../domain/errors';
import { WagerOutcomeError, resultJson } from './wager-outcome';

// The one exception filter (D20): body is always { code, message }.
const mapping: [new (...a: any[]) => Error, number, string][] = [
  [ValidationError, 400, 'VALIDATION_ERROR'],
  [InvalidMoneyError, 400, 'VALIDATION_ERROR'],
  [WalletAlreadyExistsError, 409, 'WALLET_ALREADY_EXISTS'],
  [NotFoundError, 404, 'NOT_FOUND'],
  [IdempotencyConflictError, 409, 'IDEMPOTENCY_CONFLICT'],
  [ExternalIdConflictError, 409, 'EXTERNAL_ID_CONFLICT'],
  [WalletNotFoundError, 422, 'WALLET_NOT_FOUND'],
  [WalletPlayerMismatchError, 422, 'WALLET_PLAYER_MISMATCH'],
  [TransientError, 503, 'TEMPORARILY_UNAVAILABLE'],
];

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof WagerOutcomeError) {
      const failed = e.tx.status === 'FAILED'; // REJECTED -> 422 with its Failure Code, FAILED -> 500 (D20)
      return res.status(failed ? 500 : 422).json({ code: failed ? 'INTERNAL_ERROR' : e.tx.failureCode, message: e.message, ...resultJson(e.tx, e.replay) });
    }
    const hit = mapping.find(([cls]) => e instanceof cls);
    if (e instanceof TransientError) res.setHeader('Retry-After', '1');
    if (hit) return res.status(hit[1]).json({ code: hit[2], message: (e as Error).message });
    if (e instanceof HttpException) {
      const s = e.getStatus();
      return res.status(s).json({ code: s === 404 ? 'NOT_FOUND' : s === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message: e.message });
    }
    console.error(e);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Internal error' });
  }
}
