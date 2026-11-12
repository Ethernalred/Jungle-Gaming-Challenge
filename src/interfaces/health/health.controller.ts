import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

export const SQS_CLIENT = 'SQS_CLIENT';

@Controller('health')
@ApiTags('Health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Check process liveness' })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { status: { type: 'string', enum: ['up'] } }, required: ['status'] } })
  live() { return { status: 'up' }; }

  @Get('ready')
  @ApiOperation({ summary: 'Check PostgreSQL and SQS readiness' })
  @ApiResponse({ status: 200, schema: { type: 'object', properties: { status: { type: 'string', enum: ['ready'] }, postgres: { type: 'string', enum: ['up'] }, sqs: { type: 'string', enum: ['up'] } }, required: ['status', 'postgres', 'sqs'] } })
  @ApiResponse({ status: 503, description: 'A dependency is unreachable. The HTTP error filter returns code and message.', schema: { type: 'object', properties: { code: { type: 'string', example: 'INTERNAL_ERROR' }, message: { type: 'string' } }, required: ['code', 'message'] } })
  async ready() {
    const timeout = AbortSignal.timeout(2000);
    const [db, sqs] = await Promise.all([
      this.orm.em.getConnection().execute('select 1').then(() => 'up', () => 'down'),
      this.sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }), { abortSignal: timeout }).then(() => 'up', () => 'down'),
    ]);
    const body = { status: db === 'up' && sqs === 'up' ? 'ready' : 'unavailable', postgres: db, sqs };
    if (body.status !== 'ready') throw new ServiceUnavailableException(body);
    return body;
  }
}
