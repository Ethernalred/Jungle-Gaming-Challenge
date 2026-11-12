import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { v7 as uuid } from 'uuid';
import { AppModule } from '../../src/app.module';
import { setupSwagger } from '../../src/interfaces/http/swagger';

export async function startApp() {
  const app: INestApplication = await NestFactory.create(AppModule, { logger: false });
  setupSwagger(app);
  await app.listen(0);
  return { app, base: await app.getUrl() };
}

export const openWallet = async (base: string, amount: string, currency = 'BRL', playerId = uuid()) => {
  const w = await (await fetch(`${base}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerId, initialBalance: { amount, currency } }) })).json();
  return { walletId: w.id as string, playerId };
};

export type Sub = { providerId?: string; externalTransactionId?: string; playerId: string; walletId: string; kind?: string; amount?: string; currency?: string; [k: string]: unknown };
export const bodyOf = (s: Sub) => ({
  providerId: s.providerId ?? 'prov-a', externalTransactionId: s.externalTransactionId ?? uuid(), playerId: s.playerId, walletId: s.walletId,
  roundId: 'round-1', gameId: 'game-1', kind: s.kind ?? 'BET', money: { amount: s.amount ?? '10.00', currency: s.currency ?? 'BRL' },
});
export const submit = (base: string, body: Record<string, unknown>, key?: string | null) =>
  fetch(`${base}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key === null ? {} : { 'idempotency-key': key ?? `${body.providerId}:${body.externalTransactionId}` }) },
    body: JSON.stringify(body),
  });
