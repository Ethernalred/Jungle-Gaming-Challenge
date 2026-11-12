import { Controller, Get, Header, Inject } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { outboxLag, registry } from '../../infrastructure/metrics/metrics';
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';

@Controller('metrics')
@ApiTags('Metrics')
export class MetricsController {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  @Get()
  @ApiOperation({ summary: 'Scrape Prometheus metrics' })
  @ApiProduces('text/plain')
  @ApiResponse({ status: 200, description: 'Prometheus exposition format.', schema: { type: 'string' } })
  @Header('content-type', registry.contentType)
  async scrape() {
    const [r] = await this.orm.em.fork().execute(`select coalesce(extract(epoch from now() - min(created_at)), 0)::float8 as lag from outbox_events where published_at is null`);
    outboxLag.set(Number(r.lag));
    return registry.metrics();
  }
}
