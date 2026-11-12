import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { bodyOf, openWallet, startApp, submit } from '../support/app';

setDefaultTimeout(60_000);
let running: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { running = await startApp(); });
afterAll(async () => { await running?.app.close(); });

test('Swagger serves UI, assets, JSON and YAML with all HTTP contracts and resolvable schema references', async () => {
  const response = await fetch(`${running.base}/docs-json`);
  expect(response.status).toBe(200);
  const doc = await response.json();
  expect(Object.keys(doc.paths).sort()).toEqual([
    '/wallets', '/wallets/{walletId}', '/wallets/{walletId}/ledger', '/wallets/{walletId}/reconciliation',
    '/wagering/transactions', '/wagering/transactions/{transactionId}',
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}', '/health/live', '/health/ready', '/metrics',
  ].sort());
  const post = doc.paths['/wagering/transactions'].post;
  expect(post.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }));
  for (const status of ['200', '201', '202', '400', '409', '422', '500', '503']) expect(post.responses[status]).toBeDefined();
  expect(doc.components.schemas.InputMoney.properties.amount.type).toBe('string');
  expect(doc.components.schemas.WagerRequest.properties.kind.enum).not.toContain('OPENING');
  expect(doc.components.schemas.WagerRequest.required).not.toContain('referenceExternalTransactionId');
  const inspect = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      expect(value.$ref.startsWith('#/components/schemas/')).toBe(true);
      expect(doc.components.schemas[value.$ref.split('/').at(-1)]).toBeDefined();
    }
    Object.values(value).forEach(inspect);
  };
  inspect(doc);
  expect(await (await fetch(`${running.base}/docs`)).text()).toContain('swagger-ui');
  expect((await fetch(`${running.base}/docs/swagger-ui-bundle.js`)).status).toBe(200);
  expect((await fetch(`${running.base}/docs-yaml`)).status).toBe(200);
});

test('documented transaction workflow uses exact money, enforces the header, and replays once', async () => {
  const wallet = await openWallet(running.base, '100.00');
  const request = bodyOf({ ...wallet, amount: '25.00' });
  expect((await submit(running.base, request, null)).status).toBe(400);
  const first = await submit(running.base, request);
  expect(first.status).toBe(201);
  const processed = await first.json();
  expect(processed.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  const replay = await submit(running.base, request);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...processed, idempotentReplay: true });
  const reconciliation = await (await fetch(`${running.base}/wallets/${wallet.walletId}/reconciliation`, { method: 'POST' })).json();
  expect(reconciliation.consistent).toBe(true);
  expect(reconciliation.storedBalance.amount).toBe('75.00');
});
