import 'reflect-metadata';
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { AppModule, sqsClient } from '../../src/app.module';
import ormConfig from '../../src/infrastructure/persistence/orm.config';
import { HealthController } from '../../src/interfaces/health/health.controller';
setDefaultTimeout(60_000);

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(() => app.close());

test('GET /health/live is 200', async () => {
  expect((await fetch(`${base}/health/live`)).status).toBe(200);
});

test('GET /health/ready is 200 when PostgreSQL and SQS are up', async () => {
  const res = await fetch(`${base}/health/ready`);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ postgres: 'up', sqs: 'up' });
});

test('GET /health/ready is 503 when PostgreSQL is unreachable (closed port)', async () => {
  const orm = await MikroORM.init({ ...ormConfig, clientUrl: 'postgres://jungle:jungle@localhost:1/jungle' });
  const ctrl = new HealthController(orm, sqsClient());
  const err: any = await ctrl.ready().catch((e) => e);
  expect(err.getStatus()).toBe(503);
  expect(err.getResponse()).toMatchObject({ postgres: 'down', sqs: 'up' });
  await orm.close();
});

test('LocalStack init created the three FIFO queues with a redrive policy (maxReceiveCount 5)', async () => {
  const sqs = sqsClient();
  const url = async (n: string) => (await sqs.send(new GetQueueUrlCommand({ QueueName: n }))).QueueUrl!;
  await url('wager-events.fifo');
  const dlq = await url('wager-transactions-dlq.fifo');
  const q = await url('wager-transactions.fifo');
  const attrs = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: q, AttributeNames: ['RedrivePolicy'] }))).Attributes!;
  const policy = JSON.parse(attrs.RedrivePolicy!);
  expect(policy.maxReceiveCount).toBe(5);
  expect(policy.deadLetterTargetArn).toContain('wager-transactions-dlq.fifo');
  expect(dlq).toContain('dlq');
});
