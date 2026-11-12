import type { INestApplication } from '@nestjs/common';
import { applyDecorators } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, ApiResponse } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const text = { type: 'string' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const object = (properties: SchemaObject['properties'], required = Object.keys(properties ?? {})): SchemaObject => ({ type: 'object', properties, required });

export const moneySchema = object({
  amount: { type: 'string', pattern: '^\\d+\\.\\d{2}$', example: '25.00', description: 'Exact decimal string with two places; never a JSON number.' },
  currency: { type: 'string', pattern: '^[A-Z]{3}$', example: 'BRL' },
});
export const openWalletSchema = object({ playerId: uuid, initialBalance: ref('InputMoney') });
export const wagerSchema = object({
  providerId: { ...text, example: 'provider-a' },
  externalTransactionId: { ...text, example: 'bet-001' }, playerId: uuid, walletId: uuid,
  roundId: { ...text, example: 'round-1' }, gameId: { ...text, example: 'game-1' },
  kind: { type: 'string', enum: ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'], example: 'BET' },
  money: ref('InputMoney'),
  referenceExternalTransactionId: { ...text, description: 'Required for REFUND/ROLLBACK; optional for WIN. External ID from the same provider and round.' },
}, ['providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money']);

const outcome = object({
  transactionId: uuid, status: { type: 'string', enum: ['PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'] },
  balance: ref('Money'), idempotentReplay: { type: 'boolean' },
});
const error = object({ code: { ...text, example: 'VALIDATION_ERROR' }, message: text });
const schemas: Record<string, SchemaObject> = {
  Money: object({ ...moneySchema.properties, amount: { type: 'string', pattern: '^-?\\d+\\.\\d{2}$', example: '25.00', description: 'Exact decimal string; reconciliation differences may be negative.' } }),
  InputMoney: moneySchema, OpenWallet: openWalletSchema, WagerRequest: wagerSchema,
  Wallet: object({ id: uuid, playerId: uuid, balance: ref('Money'), version: { type: 'integer', minimum: 1 } }),
  WagerOutcome: outcome,
  WagerTransaction: object({
    transactionId: uuid, status: outcome.properties!.status, balance: ref('Money'),
    providerId: text, externalTransactionId: text, playerId: uuid, walletId: uuid, roundId: { ...text, nullable: true }, gameId: { ...text, nullable: true },
    kind: { type: 'string', enum: ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] }, money: ref('Money'),
    failureCode: { ...text, nullable: true }, referenceExternalTransactionId: { ...text, nullable: true },
    createdAt: date, processedAt: { ...date, nullable: true },
  }, ['transactionId', 'status', 'balance', 'providerId', 'externalTransactionId', 'playerId', 'walletId', 'roundId', 'gameId', 'kind', 'money', 'createdAt', 'processedAt']),
  LedgerEntry: object({ id: uuid, transactionId: uuid, direction: { type: 'string', enum: ['DEBIT', 'CREDIT'] }, money: ref('Money'), balanceBefore: ref('Money'), balanceAfter: ref('Money'), createdAt: date }),
  LedgerPage: object({ items: { type: 'array', items: ref('LedgerEntry') }, nextCursor: { ...text, nullable: true } }),
  Reconciliation: object({ walletId: uuid, storedBalance: ref('Money'), calculatedBalance: ref('Money'), difference: ref('Money'), consistent: { type: 'boolean' }, checkedEntries: { type: 'integer' } }),
  Error: error,
  WagerError: { allOf: [ref('Error'), ref('WagerOutcome')] },
};

export const responseSchema = ref;
export function ApiErrors(...statuses: number[]) {
  const descriptions: Record<number, string> = {
    400: 'Invalid payload, money format, query, or missing Idempotency-Key.',
    404: 'Resource not found.', 409: 'Duplicate wallet, conflicting idempotency key, or external transaction ID.',
    422: 'Business rejection; stored transactions include status, balance, and replay flag. Unknown wallet/player mismatches may only return code and message.',
    500: 'Permanent failure or unexpected server error.', 503: 'Temporary infrastructure failure; retry the same request after Retry-After seconds.',
  };
  return applyDecorators(...statuses.map((status) => ApiResponse({
    status, description: descriptions[status],
    schema: status === 422 || status === 500 ? { anyOf: [ref('Error'), ref('WagerError')] } : ref('Error'),
    ...(status === 503 ? { headers: { 'Retry-After': { schema: { type: 'string', example: '1' } } } } : {}),
  })));
}

export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder().setTitle('Jungle Gaming Challenge API').setVersion('1.0.0')
    .setDescription('Wallets and wagering transactions. Amounts are decimal strings. Authentication is not implemented. HTTP and SQS share the same business rules; SQS is described in the README.')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.components ??= {};
  document.components.schemas = { ...document.components.schemas, ...schemas };
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: '/docs-json', yamlDocumentUrl: '/docs-yaml',
    swaggerOptions: { displayRequestDuration: true },
  });
  return document;
}
