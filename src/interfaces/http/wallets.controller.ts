import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { WalletService } from '../../application/wallets';
import { ValidationError } from '../../domain/errors';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import { Wallet } from '../../domain/wallet';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiErrors, responseSchema } from './swagger';

const walletJson = (w: Wallet) => ({ id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version });
const entryJson = (e: WalletLedgerEntry) => ({
  id: e.id, transactionId: e.transactionId, direction: e.direction, money: e.money.toJSON(),
  balanceBefore: e.balanceBefore.toJSON(), balanceAfter: e.balanceAfter.toJSON(), createdAt: e.createdAt.toISOString(),
});

@Controller('wallets')
@ApiTags('Wallets')
@ApiErrors(400, 404, 503)
export class WalletsController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Post()
  @ApiOperation({ summary: 'Open a wallet', description: 'Positive initial balances create an internal OPENING transaction and ledger credit atomically.' })
  @ApiBody({ schema: responseSchema('OpenWallet') })
  @ApiResponse({ status: 201, description: 'Wallet created.', schema: responseSchema('Wallet') })
  @ApiErrors(409)
  async open(@Body() body: any) {
    return walletJson(await this.wallets.open({ playerId: body?.playerId, initialBalance: body?.initialBalance }));
  }

  @Get(':walletId')
  @ApiOperation({ summary: 'Get wallet balance and version' })
  @ApiResponse({ status: 200, schema: responseSchema('Wallet') })
  async get(@Param('walletId') id: string) {
    return walletJson(await this.wallets.get(id));
  }

  @Post(':walletId/reconciliation')
  @ApiOperation({ summary: 'Compare stored balance against the ledger', description: 'Reports discrepancies without modifying balances.' })
  @ApiResponse({ status: 200, schema: responseSchema('Reconciliation') })
  @HttpCode(200)
  async reconcile(@Param('walletId') id: string) {
    const r = await this.wallets.reconcile(id);
    return {
      walletId: r.walletId, storedBalance: r.stored.toJSON(), calculatedBalance: r.calculated.toJSON(),
      difference: r.difference.toJSON(), consistent: r.consistent, checkedEntries: r.checkedEntries,
    };
  }

  @Get(':walletId/ledger')
  @ApiOperation({ summary: 'List ledger entries', description: 'Stable pagination by creation time and ID; not guaranteed to reflect application order under contention.' })
  @ApiQuery({ name: 'cursor', required: false, type: String, description: 'Opaque nextCursor from the previous page.' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } })
  @ApiResponse({ status: 200, schema: responseSchema('LedgerPage') })
  async ledger(@Param('walletId') id: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    if (limit !== undefined && !/^\d+$/.test(limit)) throw new ValidationError('limit must be an integer 1..200');
    const page = await this.wallets.ledger(id, cursor, limit === undefined ? undefined : Number(limit));
    return { items: page.items.map(entryJson), nextCursor: page.nextCursor };
  }
}
