import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import { appOrmConfig } from './infrastructure/persistence/orm.config';
import { Clock, SystemClock } from './domain/clock';
import { IdGenerator, UuidV7Generator } from './domain/id-generator';
import { WalletRepository } from './application/ports';
import { WalletService } from './application/wallets';
import { MikroWalletRepository } from './infrastructure/persistence/wallet.repository';
import { WalletsController } from './interfaces/http/wallets.controller';
import { AllExceptionsFilter } from './interfaces/http/exception-filter';
import { APP_FILTER } from '@nestjs/core';
import { SubmitWagerTransaction } from './application/submit-wager-transaction';
import { WagerTransactionRepository } from './application/wager-ports';
import { MikroWagerTransactionRepository } from './infrastructure/persistence/wager-transaction.repository';
import { AuthGuard, NoopProviderIdentity, ProviderIdentityPort } from './infrastructure/auth/provider-identity';
import { WageringController } from './interfaces/http/wagering.controller';
import { PendingReferenceWorker } from './application/pending-reference-worker';
import { OutboxPublisher } from './infrastructure/sqs/outbox-publisher';
import { WagerConsumer } from './infrastructure/sqs/wager-consumer';
import { HealthController, SQS_CLIENT } from './interfaces/health/health.controller';
import { MetricsController } from './interfaces/http/metrics.controller';
import { correlationMiddleware } from './interfaces/http/correlation.middleware';

export const sqsEndpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:54566';

export const sqsClient = (endpoint = sqsEndpoint) =>
  new SQSClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

@Module({
  controllers: [HealthController, MetricsController, WalletsController, WageringController],
  providers: [
    { provide: MikroORM, useFactory: () => MikroORM.init(appOrmConfig) },
    { provide: SQS_CLIENT, useFactory: () => sqsClient() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: WalletRepository, useFactory: (orm: MikroORM) => new MikroWalletRepository(orm), inject: [MikroORM] },
    { provide: WalletService, useFactory: (r: WalletRepository, c: Clock, i: IdGenerator) => new WalletService(r, c, i), inject: [WalletRepository, Clock, IdGenerator] },
    { provide: WagerTransactionRepository, useFactory: (orm: MikroORM) => new MikroWagerTransactionRepository(orm), inject: [MikroORM] },
    { provide: SubmitWagerTransaction, useFactory: (r: WagerTransactionRepository, c: Clock, i: IdGenerator) => new SubmitWagerTransaction(r, c, i), inject: [WagerTransactionRepository, Clock, IdGenerator] },
    { provide: OutboxPublisher, useFactory: (orm: MikroORM, sqs: SQSClient) => new OutboxPublisher(orm, sqs), inject: [MikroORM, SQS_CLIENT] },
    { provide: PendingReferenceWorker, useFactory: (r: WagerTransactionRepository, c: Clock, i: IdGenerator) => new PendingReferenceWorker(r, c, i), inject: [WagerTransactionRepository, Clock, IdGenerator] },
    { provide: WagerConsumer, useFactory: (orm: MikroORM, sqs: SQSClient, u: SubmitWagerTransaction) => new WagerConsumer(orm, sqs, u), inject: [MikroORM, SQS_CLIENT, SubmitWagerTransaction] },
    { provide: ProviderIdentityPort, useClass: NoopProviderIdentity },
    AuthGuard,
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
  ],
  exports: [MikroORM, Clock, IdGenerator],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) { consumer.apply(correlationMiddleware).forRoutes('*'); }
}
