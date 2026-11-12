import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { WagerTransactionRepository } from '../../application/wager-ports';
import { isUuid } from '../../application/wallets';
import { NotFoundError, ValidationError } from '../../domain/errors';
import { WagerTransaction } from '../../domain/wager-transaction';
import { AuthGuard } from '../../infrastructure/auth/provider-identity';
import { WagerOutcomeError, resultJson } from './wager-outcome';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors, responseSchema } from './swagger';

const txJson = (tx: WagerTransaction) => {
  const s = tx.state;
  return {
    ...resultJson(tx, false), idempotentReplay: undefined, providerId: s.providerId, externalTransactionId: s.externalTransactionId,
    playerId: s.playerId, walletId: s.walletId, roundId: s.roundId, gameId: s.gameId, kind: s.kind, money: s.money.toJSON(),
    failureCode: s.failureCode, referenceExternalTransactionId: s.referenceExternalTransactionId,
    createdAt: s.createdAt.toISOString(), processedAt: s.processedAt?.toISOString() ?? null,
  };
};

@Controller()
@ApiTags('Wagering')
@ApiErrors(400, 404, 503)
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(WagerTransactionRepository) private readonly repo: WagerTransactionRepository,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({ summary: 'Submit a wagering transaction', description: 'Same key and business payload replays the stored outcome; changing the payload conflicts. REFUND/ROLLBACK require a reference. OPENING is internal.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Stable key per provider operation. Reuse on retries.', example: 'provider-a:bet-001' })
  @ApiBody({ schema: responseSchema('WagerRequest') })
  @ApiResponse({ status: 201, description: 'Processed for the first time.', schema: responseSchema('WagerOutcome') })
  @ApiResponse({ status: 200, description: 'Replay of a processed transaction; returns the original balance snapshot.', schema: responseSchema('WagerOutcome') })
  @ApiResponse({ status: 202, description: 'Accepted; waiting for the referenced transaction.', schema: responseSchema('WagerOutcome') })
  @ApiErrors(409, 422, 500)
  async post(@Body() body: any, @Headers('idempotency-key') key: string | undefined, @Res({ passthrough: true }) res: any) {
    if (!key?.trim()) throw new ValidationError('Idempotency-Key header is required');
    const { transaction: tx, replay } = await this.submit.execute({ ...body, idempotencyKey: key });
    if (tx.status === 'REJECTED' || tx.status === 'FAILED') throw new WagerOutcomeError(tx, replay);
    res.status(tx.status === 'PENDING_REFERENCE' ? 202 : replay ? 200 : 201); // D20
    return resultJson(tx, replay);
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({ summary: 'Get a transaction by internal ID' })
  @ApiResponse({ status: 200, schema: responseSchema('WagerTransaction') })
  async byId(@Param('transactionId') id: string) {
    const tx = isUuid(id) ? await this.repo.findById(id) : null;
    if (!tx) throw new NotFoundError('Wager Transaction not found');
    return txJson(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({ summary: 'Get a transaction by provider and external ID' })
  @ApiResponse({ status: 200, schema: responseSchema('WagerTransaction') })
  async byExternal(@Param('providerId') providerId: string, @Param('externalTransactionId') ext: string) {
    const tx = await this.repo.findByExternal(providerId, ext);
    if (!tx) throw new NotFoundError('Wager Transaction not found');
    return txJson(tx);
  }
}
