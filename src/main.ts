import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WagerConsumer } from './infrastructure/sqs/wager-consumer';
import { setupSwagger } from './interfaces/http/swagger';

const app = await NestFactory.create(AppModule);
app.enableShutdownHooks(); // SIGTERM: providers' onModuleDestroy runs (consumer drains in-flight messages, D26)
setupSwagger(app);
await app.listen(Number(process.env.PORT ?? 3000));
if (process.env.QUEUE_CONSUMER !== 'off') app.get(WagerConsumer).start();
