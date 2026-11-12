# JungleGame

Wager-ledger service: keeps player Wallet Balances correct while game Providers send Wager Transactions that arrive duplicated, out of order or at the same time. Bun 1.x, TypeScript strict, NestJS 11, MikroORM v7, PostgreSQL 17, SQS on LocalStack. Design, trade-offs and limits: [ARCHITECTURE.md](ARCHITECTURE.md). Terms: [GLOSSARY.md](GLOSSARY.md). Decisions: [docs/adr](docs/adr).

## Como a solução atende ao enunciado

Este mapa relaciona os requisitos de [Requirements.md](Requirements.md) às garantias implementadas e aos testes disponíveis. A existência de um teste indica onde verificar o comportamento; não significa que a suíte foi executada nesta revisão da documentação. Ressalvas e problemas conhecidos estão descritos ao final desta seção.

### Visão geral, domínio e stack — seções 1, 3 e 4

O serviço recebe transações de múltiplos provedores por HTTP e SQS. As duas entradas usam o mesmo caso de uso, [SubmitWagerTransaction](src/application/submit-wager-transaction.ts), para que duplicatas, concorrência e entregas fora de ordem sejam tratadas pelas mesmas regras.

| Exigência | Como é atendida | Evidência |
|---|---|---|
| Bun 1.x, TypeScript estrito e NestJS | Scripts executados com Bun, `strict` no compilador e aplicação modular NestJS | [package.json](package.json), [tsconfig.json](tsconfig.json), [app.module.ts](src/app.module.ts) |
| PostgreSQL e SQS em ambiente local | Docker Compose com PostgreSQL e LocalStack; script cria filas de entrada, DLQ e eventos | [docker-compose.yml](docker-compose.yml), [localstack-init.sh](infra/localstack-init.sh) |
| MikroORM e migrations reversíveis | EntitySchema, Unit of Work e transações explícitas; migrations versionadas com operações de subida e descida | [persistência](src/infrastructure/persistence), [ADR-0004](docs/adr/0004-mikroorm-v7-entityschema.md) |
| Domínio separado de framework e ORM | Classes de domínio encapsulam regras; aplicação depende de portas; adaptadores implementam persistência, transporte e observabilidade | [domínio](src/domain), [portas](src/application/wager-ports.ts), [ARCHITECTURE.md](ARCHITECTURE.md) |

### Autenticação — seção 2

A opção adotada é não implementar autenticação neste desafio, conforme permitido pelo enunciado. O ponto de extensão é [ProviderIdentityPort e AuthGuard](src/infrastructure/auth/provider-identity.ts). O desenho proposto em [ARCHITECTURE.md](ARCHITECTURE.md#authentication-not-implemented-by-choice) usa Keycloak/OIDC, validação de JWT e vínculo entre a identidade autenticada e `providerId`, sem tabela própria de senhas. Esse desenho ainda não está implementado. Health checks ficam abertos e a fila é tratada como canal interno confiável.

### Restrições invioláveis — seção 5

| Restrição | Garantia implementada |
|---|---|
| Dinheiro sem `number`, `float` ou `double` | [Money](src/domain/money.ts) calcula com centavos em `bigint`; contratos usam strings decimais; banco usa `NUMERIC(19,2)` e mapeamento por string. |
| Idempotência persistente | Constraints únicas por provedor e chave/identificador externo; hash e resultado ficam no PostgreSQL, sobrevivendo a reinícios. |
| Correção independente do FIFO | Locks e constraints do PostgreSQL protegem os efeitos financeiros; deduplicação do broker é uma otimização. |
| Publicar somente após commit | Eventos são gravados na outbox na transação financeira; um publisher separado lê os registros confirmados. |
| Ledger sem atualização ou exclusão | Classe sem transições mutáveis, trigger que rejeita `UPDATE`/`DELETE` e papel da aplicação sem essas permissões. |
| Sem lock global | Cada transação bloqueia a linha da wallet envolvida com `SELECT … FOR UPDATE`; wallets distintas podem avançar em paralelo. |
| Sem lost update | Leitura do saldo, validação e gravação acontecem sob o mesmo lock e na mesma transação SQL. |
| Múltiplas instâncias | A coordenação fica no PostgreSQL; os testes incluem três processos reais da aplicação. |
| Proteções também no schema | `CHECK` de saldo não negativo e aritmética do ledger, índices únicos, chaves e proteção de imutabilidade nas [migrations](src/infrastructure/persistence/migrations). |

Implementação e verificações: [repositório transacional](src/infrastructure/persistence/wager-transaction.repository.ts), [constraints](test/integration/wallet-constraints.test.ts), [invariantes negativas](test/integration/invariants-negative.test.ts) e [permissões do papel da aplicação](test/integration/app-role.test.ts).

### Modelagem financeira — seção 6

| Modelo | Como atende ao requisito | Testes |
|---|---|---|
| [Money](src/domain/money.ts) | Imutável, construtor privado, factories, operações exatas e verificação de moeda. Entrada exige string com duas casas; rejeita negativos, NaN, Infinity, expoentes, vazio e escala inválida. Serializa com duas casas, sem arredondamento silencioso. | [money.test.ts](test/unit/money.test.ts) |
| [Wallet](src/domain/wallet.ts) | Aggregate com criação e reidratação explícitas; débito/crédito preservam saldo e produzem ledger. Versão começa em 1 e muda quando o saldo muda. Unicidade de jogador/moeda e saldo não negativo também são protegidos no banco. | [wallet.test.ts](test/unit/wallet.test.ts), [wallets-api.test.ts](test/integration/wallets-api.test.ts) |
| [WagerTransaction](src/domain/wager-transaction.ts) | Criação em `PENDING`, transições explícitas e estados terminais `PROCESSED`, `REJECTED`, `FAILED`. Guarda hash, referência, código de falha e snapshot do saldo. `OPENING` é interno. | [wager-transaction.test.ts](test/unit/wager-transaction.test.ts), [wagering-api.test.ts](test/integration/wagering-api.test.ts) |
| [WalletLedgerEntry](src/domain/ledger-entry.ts) | Registro imutável que valida saldo anterior ± valor = saldo posterior. Banco limita a um lançamento por wallet/transação. `LOSS` e rejeições não geram lançamentos. | [wallet.test.ts](test/unit/wallet.test.ts), [wallet-constraints.test.ts](test/integration/wallet-constraints.test.ts) |
| [Inbox e Outbox](src/domain/outbox.ts) | Estado persistente de recebimento/publicação, detecção de duplicata e controle de tentativas. Inbox, efeito financeiro, ledger e outbox compartilham a transação SQL. | [outbox.test.ts](test/unit/outbox.test.ts), [commit-boundary.test.ts](test/integration/commit-boundary.test.ts), [queue-consumer.test.ts](test/integration/queue-consumer.test.ts) |

### Regras de negócio e referências fora de ordem — seção 7

| Operação | Comportamento |
|---|---|
| `BET` | Debita e gera `DEBIT`; saldo insuficiente resulta em `REJECTED / INSUFFICIENT_FUNDS`. |
| `WIN` | Credita e gera `CREDIT`; pode referenciar uma BET da mesma rodada e ter valor diferente dela. |
| `LOSS` | Registra `PROCESSED`, sem alterar saldo, versão ou ledger. |
| `REFUND` | Credita o valor integral de uma BET processada, validando identidade, moeda e rodada. |
| `ROLLBACK` | Inverte BET, WIN ou REFUND processado; se o débito resultante exceder o saldo, rejeita com `REVERSAL_WOULD_OVERDRAW`. |
| `OPENING` | Criado internamente, junto da wallet e do crédito inicial, na mesma transação SQL, quando o saldo inicial é maior que zero. API e fila não aceitam essa operação externa. |

As [regras de referência](src/domain/reference-rules.ts) e o [resolvedor](src/application/resolve-reference.ts) verificam provedor, jogador, wallet, moeda, rodada, tipo, estado e valor da referência. Reversões parciais são rejeitadas. A solução adota uma interpretação mais restritiva: **uma única reversão processada por referência, considerando REFUND e ROLLBACK juntos**, protegida por índice parcial único; justificativa no [ADR-0003](docs/adr/0003-one-reversal-per-reference.md).

Referência ausente permanece em `PENDING_REFERENCE`, sem movimentar saldo. O [worker](src/application/pending-reference-worker.ts) tenta novamente com backoff exponencial, até oito tentativas, aproximadamente 8,5 minutos. Ao esgotar, registra `REJECTED / REFERENCE_NOT_FOUND` e gera evento de rejeição. Reenvios idênticos usam o resultado persistido; o saldo retornado no replay é o snapshot original. Os códigos de falha e as ações esperadas do provedor estão em [ARCHITECTURE.md](ARCHITECTURE.md#failure-codes-what-the-provider-should-do).

Verificações: [regras de referência](test/unit/reference-rules.test.ts), [reversões](test/integration/reversals.test.ts), [corrida entre reversões](test/concurrency/reversal-race.test.ts) e [worker de referências](test/integration/pending-reference-worker.test.ts).

### Concorrência e ordenação — seção 8

O [repositório](src/infrastructure/persistence/wager-transaction.repository.ts) abre uma transação e adquire lock pessimista na wallet antes de aplicar a movimentação. A espera por lock é limitada a dois segundos; timeout é transitório, com HTTP 503 ou retry na fila. Essa estratégia evita lost updates entre processos sem bloquear globalmente wallets distintas; a justificativa está no [ADR-0002](docs/adr/0002-pessimistic-lock-per-wallet.md).

O [teste de concorrência](test/concurrency/submit-wager-transaction.test.ts) cobre explicitamente o cenário de saldo `100.00` e duas apostas simultâneas de `80.00`: uma processada, outra rejeitada, saldo final `20.00` e um único débito. Também envia a mesma aposta 50 vezes em paralelo e exige um débito, uma resposta inicial e 49 replays. Há testes com wallets distintas, [interleavings forçados](test/concurrency/forced-interleavings.test.ts) e [três processos](test/multi-instance/mixed-load.test.ts).

### API HTTP e idempotência — seção 9

Os endpoints e exemplos estão na seção HTTP API abaixo. A [criação da wallet](src/application/wallets.ts) persiste abertura e ledger atomicamente; as consultas expõem saldo/versão, ledger com cursor, transação por ID e por identidade do provedor. Wallet duplicada retorna conflito.

O header `Idempotency-Key` é obrigatório. O [hash do payload](src/domain/wager-transaction.ts) usa SHA-256 de JSON canônico, ordenando chaves recursivamente e incluindo campos de negócio, sem metadados de transporte. Chaves únicas por provedor impedem duplicação; mesma chave com conteúdo diferente produz `IDEMPOTENCY_CONFLICT`, e identificador externo reutilizado com outra chave produz `EXTERNAL_ID_CONFLICT`.

O [filtro HTTP](src/interfaces/http/exception-filter.ts) distingue validação (400), conflito (409), rejeição de negócio (422), pendência (202), processamento inicial (201), replay processado (200) e indisponibilidade transitória (503 com `Retry-After`). Há exceções conhecidas na classificação de entradas extremas, listadas adiante.

A [reconciliação](src/application/reconciliation.ts) reconstrói o saldo pelo ledger sob lock de leitura, compara com o saldo materializado e retorna diferença e quantidade de lançamentos. Divergências são sinalizadas na resposta, em log e métrica, sem correção silenciosa. [Health checks](src/interfaces/health/health.controller.ts) separam processo vivo de prontidão do PostgreSQL e SQS. Testes: [API financeira](test/integration/wagering-api.test.ts), [wallets](test/integration/wallets-api.test.ts), [reconciliação](test/integration/reconciliation.test.ts) e [health](test/integration/health.test.ts).

### SQS, retry, DLQ e shutdown — seção 10

O [consumer](src/infrastructure/sqs/wager-consumer.ts) chama o mesmo caso de uso do HTTP. A [inbox](src/infrastructure/persistence/inbox.repository.ts) deduplica por `(consumerName, messageId)` e confere o hash do conteúdo. O ack, feito com `DeleteMessage`, ocorre após a conclusão da transação. Erros de negócio são terminais e recebem ack; erros permanentes identificados seguem para DLQ; transitórios ficam disponíveis novamente após backoff. A política de redrive limita entregas a cinco antes da DLQ. Na parada por SIGTERM, o consumidor aguarda mensagens em andamento por até dez segundos e devolve visibilidade quando necessário.

Testes com PostgreSQL e LocalStack: [consumer, inbox, retry e DLQ](test/integration/queue-consumer.test.ts), [crash e shutdown](test/integration/queue-crash.test.ts) e [morte após commit e antes do ack](test/multi-instance/crash-restart.test.ts).

### Transactional Outbox e eventos — seção 11

A [gravação da outbox](src/infrastructure/persistence/outbox.ts) participa da mesma transação que wallet, transação financeira, ledger e inbox. Rollback desfaz o conjunto. Após commit, o [publisher](src/infrastructure/sqs/outbox-publisher.ts) seleciona registros com `FOR UPDATE SKIP LOCKED`, permitindo publishers concorrentes. Só marca publicado depois de enviar; falhas reagendam com backoff, sem descartar eventos confirmados por limite de tentativas.

Os [eventos de integração](src/domain/events/integration-event.ts) têm classe abstrata e subclasses concretas com tipo e versão: `WagerTransactionProcessed` (incluindo LOSS), `WagerTransactionRejected`, `WalletBalanceChanged` (somente quando há mudança de saldo) e `WagerTransactionPendingReference`. O envelope inclui identidade, correlação, causa e data; dinheiro é serializado como string decimal.

Uma queda após commit deixa o evento pendente para outra instância. Queda depois do envio e antes da marcação pode gerar nova publicação: a entrega é **at-least-once**, e consumidores devem deduplicar por `eventId`. Testes: [outbox](test/integration/outbox.test.ts), [limite do commit](test/integration/commit-boundary.test.ts), [publishers concorrentes](test/multi-instance/outbox-publishers.test.ts) e [recuperação do publisher](test/multi-instance/outbox-crash.test.ts).

### Observabilidade — seção 12

O [logger](src/infrastructure/log.ts) usa JSON e contexto com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`, conforme o fluxo. Dados financeiros e payloads são redigidos. As [métricas Prometheus](src/infrastructure/metrics/metrics.ts) cobrem status, duplicatas, retries, DLQ, conflitos de lock, lag da outbox, latência e divergências de reconciliação. Os endpoints são `/metrics`, `/health/live` e `/health/ready`. Verificações: [métricas](test/integration/observability-metrics.test.ts), [redação de logs](test/unit/log-redaction.test.ts) e [health](test/integration/health.test.ts). O caminho de erros HTTP não classificados ainda usa `console.error`, uma pendência descrita abaixo.

### Testes, avaliação e diferenciais — seções 13 e 14

| Grupo | O que verifica | Onde |
|---|---|---|
| Unidade | Money, moedas, invariantes da wallet, estados, referências, hash e eventos | [test/unit](test/unit) |
| Integração real | PostgreSQL/LocalStack, constraints, atomicidade, API, inbox/outbox, retry, DLQ e reconciliação | [test/integration](test/integration) |
| Concorrência | 50 duplicatas simultâneas, disputa por saldo, wallets independentes e reversões concorrentes | [test/concurrency](test/concurrency) |
| Múltiplas instâncias e recuperação | Três processos, reinício, morte antes do ack e publishers concorrentes | [test/multi-instance](test/multi-instance) |
| Invariante financeira | Comparação entre saldo materializado e reconstrução pelo ledger nos cenários financeiros | [ledger.ts](test/support/ledger.ts), [invariants.ts](test/support/invariants.ts) |
| Propriedades, experimentos e mutações | Sequências de operações, ordenação, pausa de instância e resistência dos testes a defeitos introduzidos | [test/property](test/property), [test/experiments](test/experiments), [test/mutations](test/mutations) |
| Carga, diferencial opcional | `bun run test:load`: três instâncias, hot wallet e wallets distribuídas; ambiente, throughput, percentis, erros, conflitos e lag documentados | [relatório de carga](docs/load-test.md), [executor](test/load/run.ts) |

Os critérios de correção financeira, concorrência, idempotência e mensageria são demonstrados pelos mecanismos e cenários acima. Modelagem e decisões estão em [ARCHITECTURE.md](ARCHITECTURE.md) e nos [ADRs](docs/adr); setup e comandos estão neste README. Isso não atribui pontuação automática nem elimina as ressalvas da implementação.

### Limitações e requisitos com ressalvas

Os pontos conhecidos que afetam a leitura deste mapa são:

- **Validação e classificação HTTP/SQS:** valores acima de `NUMERIC(19,2)`, identificadores muito longos, caractere NUL e corpo HTTP acima do limite podem receber classificação inadequada de erro (F1–F4). Portanto, a distinção entre payload inválido e falha transitória ainda não cobre todas as entradas.
- **Referências indevidas:** BET e LOSS com referência podem entrar em `PENDING_REFERENCE` antes de serem rejeitados, em vez de falhar imediatamente (F7).
- **Ledger e ordem dos eventos:** a paginação tem cursor estável, mas a ordem exibida do ledger pode diferir da ordem de aplicação sob contenção (F6). Publishers concorrentes ou retries também podem entregar eventos da mesma wallet fora da ordem de commit (F10); o broker não é a garantia financeira.
- **Disponibilidade de hot wallet:** uma instância pausada dentro da transação pode manter o lock sem prazo máximo do lado do servidor (F9). O timeout de dois segundos limita a espera dos concorrentes, não o tempo de retenção do lock.
- **Logs e conflitos SQL:** erros HTTP não classificados ainda usam `console.error` (F8). O `ON CONFLICT DO NOTHING` sem alvo pode ocultar a origem de uma violação única e produzir código de conflito inadequado (F11).
- **Escopo e interpretações:** autenticação não implementada; apenas moedas com duas casas decimais; sem reversões parciais ou ledger de partidas dobradas. O limite de oito tentativas pode rejeitar uma referência que chegue tarde. Uma única reversão total por referência é mais restritiva que uma por tipo. O estado `FAILED` fica auditável na tabela, sem evento específico.
- **Entrega e desempenho:** publicação é at-least-once; o publisher mantém a transação de claim aberta durante a chamada ao SQS. Escritas na mesma wallet são serializadas, e o consumer processa uma mensagem por vez em cada instância.

Os comandos para executar as suítes estão na seção Tests abaixo. Alguns testes usam `test.failing`: nesses casos, o teste verde registra que o defeito esperado ainda existe; se o comportamento for corrigido, o teste deve ser convertido em um teste de regressão normal.

## Prerequisites
Bun 1.x, Docker (or Podman) with Compose, `curl`, `flock` (tests), `uuidgen` (examples). Nothing else is installed globally.

## Ports and environment
| What | Value | Override |
|---|---|---|
| PostgreSQL | `localhost:55432`, user/password/db `jungle` | `DATABASE_URL` (owner: migrations, CLI, raw-SQL tests) |
| App DB role | `jungle_app`: no UPDATE/DELETE on Ledger Entries (D17) | `APP_DATABASE_URL` |
| LocalStack SQS | `localhost:54566` | `SQS_ENDPOINT` |
| App HTTP | `3000` | `PORT` |
| Switches | `OUTBOX_PUBLISHER=off`, `QUEUE_CONSUMER=off`, `PENDING_REFERENCE_WORKER=off` | one background loop each; tests use them |
| Logs | JSON on stdout, silent under `bun test` | `LOG_LEVEL` |
| Queue names | `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo` | `QUEUE_NAME`, `DLQ_NAME` |

Test child processes must listen on ports below 32768 (the Linux ephemeral range can collide).

## Setup and run
```bash
docker compose up -d --wait        # project "junglegame": postgres, localstack; infra/localstack-init.sh creates the 3 queues (DLQ redrive maxReceiveCount 5)
bun install
bunx --bun mikro-orm migration:up  # always --bun, otherwise the CLI runs under Node
bun start                          # or: PORT=20123 bun src/main.ts
bunx --bun mikro-orm migration:down   # reverts the last migration; run again to go further back
bunx tsc --noEmit
```
The app process also runs the Outbox publisher, the queue consumer and the pending-reference worker. Stop it with SIGTERM (the consumer drains in-flight messages for up to 10 s).

## Tests
Real PostgreSQL and LocalStack, no mocks (D30). Integration, concurrency and multi-instance suites share one database, so run them under the lock:
```bash
bun run test:unit                                               # no stack needed
flock ~/.cache/junglegame-db.lock bun run test:integration
flock ~/.cache/junglegame-db.lock bun run test:concurrency      # races over separate connections
flock ~/.cache/junglegame-db.lock bun run test:multi-instance   # 3 real app processes, kill -9, restart
flock ~/.cache/junglegame-db.lock bun test                      # everything
```
`bun run test:load` runs the load experiment (about 1 minute): starts 3 instances, hot-Wallet steps at client concurrency 1/4/16/32 and a 200-Wallet spread, checks Reconciliation after each step and writes [docs/load-test.md](docs/load-test.md). It takes the DB lock itself (no `flock` needed), needs the stack up, waits if the 1-minute load average is above 10 and caps in-flight requests at 32. Analysis: ARCHITECTURE.md "Load test".

## Swagger / OpenAPI

After the setup commands above, run `bun start` and open [Swagger UI](http://localhost:3000/docs). With a different `PORT`, use that port instead.

| Address | Purpose |
|---|---|
| `/docs` | Browse endpoints and execute requests with **Try it out** |
| `/docs-json` | OpenAPI JSON for Postman, Insomnia, client generation, or automated contract checks |
| `/docs-yaml` | The same contract as YAML |

The documentation includes request/response schemas, decimal money strings, the required `Idempotency-Key` header, pagination, rejection codes, and pending/replay responses. Authentication is currently a no-op; no bearer token is needed. Swagger describes HTTP; SQS uses the envelope in the Queue section below. Integration follows the [NestJS OpenAPI documentation](https://docs.nestjs.com/openapi/introduction).

To try a complete flow:

1. Execute `POST /wallets` with a fresh UUID `playerId` and `initialBalance: {"amount":"100.00","currency":"BRL"}`.
2. Copy the returned wallet ID into `POST /wagering/transactions`; reuse that `playerId`, set `kind` to `BET`, and use `money: {"amount":"25.00","currency":"BRL"}`. Set provider/external IDs, round, game, and header `Idempotency-Key: provider-a:bet-001`.
3. Expect 201, `PROCESSED`, and balance `75.00`. Execute the exact request again: expect 200, the same transaction ID/balance, and `idempotentReplay: true`.
4. Change the amount while retaining the key: expect 409 `IDEMPOTENCY_CONFLICT`.
5. Execute `POST /wallets/{walletId}/reconciliation`: expect `consistent: true` and difference `0.00`.

These calls write real data to the configured database. Use fresh identities for independent runs. Download the contract with `curl http://localhost:3000/docs-json -o openapi.json`, or import that URL into Postman/Insomnia and run the same assertions there.

## Test definitions and integration testing

| Test type | Definition in this project | How to run |
|---|---|---|
| Unit | Isolated domain rules, exact monetary arithmetic, state transitions, and helpers; no database or queue required | `bun run test:unit` |
| Integration | Multiple real components together: HTTP/controllers, application use cases, PostgreSQL migrations/constraints, or SQS via LocalStack | `flock ~/.cache/junglegame-db.lock bun run test:integration` |
| Concurrency | Simultaneous operations on separate connections; verifies locking, deduplication, and absence of lost updates | `flock ~/.cache/junglegame-db.lock bun run test:concurrency` |
| Multiple instances / recovery | Separate application processes, crashes, redelivery, restart, and concurrent publishers | `flock ~/.cache/junglegame-db.lock bun run test:multi-instance` |
| Property | Generated operation sequences checked against a financial model and invariants | `flock ~/.cache/junglegame-db.lock bun run test:property` |
| Experiments | Explicit checks of ordering and availability limits; includes expected-failure pins | `flock ~/.cache/junglegame-db.lock bun run test:experiments` |
| Load | Measured throughput/latency under a hot wallet and distributed wallets, with reconciliation | `bun run test:load` |

### Prepare and run integration tests

Use a dedicated local/test database and LocalStack, not a production environment. Tests create persistent financial fixtures and some install temporary triggers or terminate test connections. They require the owner connection `DATABASE_URL`; application requests use the restricted `APP_DATABASE_URL`. Defaults and ports are listed above.

```bash
# Linux / WSL; run setup once, then one shared-database suite at a time.
mkdir -p ~/.cache
docker compose up -d --wait
bun install
bunx --bun mikro-orm migration:up

# Whole integration suite; it starts its own HTTP applications on free ports.
flock ~/.cache/junglegame-db.lock bun run test:integration

# One file, or one named scenario. No separate bun start is required.
flock ~/.cache/junglegame-db.lock bun test test/integration/swagger.test.ts
flock ~/.cache/junglegame-db.lock bun test test/integration/wagering-api.test.ts -t "same key"

# Full suite, including concurrency and recovery.
flock ~/.cache/junglegame-db.lock bun test
```

On native PowerShell, setup commands are the same except `mkdir -p`/`flock`. Run `bun run test:integration` or `bun test test/integration/swagger.test.ts` **sequentially**, with no other database suite or background application running. Use WSL/Linux for the complete POSIX signal and crash scenarios. The fixture helpers start and close their own Nest applications; migrations must already be applied.

### Integration scenarios and expected results

| Scenario | Assertions | Existing example |
|---|---|---|
| API contract and documentation | UI/assets and JSON/YAML are served; paths and schema references resolve; required header and replay behavior agree with the API | [swagger.test.ts](test/integration/swagger.test.ts) |
| Wallet creation | 201, version 1, one opening credit for positive balance; duplicate player/currency returns 409 | [wallets-api.test.ts](test/integration/wallets-api.test.ts) |
| Wager and replay | BET debits once; same key/body returns original result; changed body returns 409; LOSS moves no money | [wagering-api.test.ts](test/integration/wagering-api.test.ts) |
| Refund/rollback | Correct inverse movement; identity and amount checks; second reversal rejected | [reversals.test.ts](test/integration/reversals.test.ts) |
| Reference arrives late | First response is 202 with no movement; worker later processes or rejects with `REFERENCE_NOT_FOUND` | [pending-reference-worker.test.ts](test/integration/pending-reference-worker.test.ts) |
| Atomic commit | Failure at commit leaves no partial wallet, ledger, inbox, outbox, or externally published event | [commit-boundary.test.ts](test/integration/commit-boundary.test.ts) |
| SQS delivery | Duplicate message creates one effect; permanent errors go to DLQ; transient failures retry; ack follows commit | [queue-consumer.test.ts](test/integration/queue-consumer.test.ts) |
| Database protections | Direct invalid writes fail: negative balance, duplicate identity, inconsistent/modified ledger | [wallet-constraints.test.ts](test/integration/wallet-constraints.test.ts), [app-role.test.ts](test/integration/app-role.test.ts) |
| Concurrent balance dispute | Two bets of 80.00 on 100.00 produce one success, one rejection, balance 20.00, and one debit | [submit-wager-transaction.test.ts](test/concurrency/submit-wager-transaction.test.ts) |
| Crash after commit, before ack | Another process consumes the redelivery with no second financial effect | [crash-restart.test.ts](test/multi-instance/crash-restart.test.ts) |

For financial scenarios, verify both the HTTP/queue outcome and the persisted invariant: **stored balance equals the signed sum of ledger entries**. An HTTP status alone does not establish atomicity or idempotency. Expected-failure pins are explained above; a green pin indicates a known defect remains.

### Add an HTTP integration test

Create `test/integration/provider-contract.test.ts`. This example starts the real application against the configured PostgreSQL/LocalStack, uses unique fixture IDs, checks replay, and verifies reconciliation:

```ts
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { bodyOf, openWallet, startApp, submit } from '../support/app';

setDefaultTimeout(60_000);
let running: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { running = await startApp(); });
afterAll(async () => { await running?.app.close(); });

test('provider retry debits exactly once', async () => {
  const wallet = await openWallet(running.base, '100.00');
  const payload = bodyOf({ ...wallet, amount: '25.00' });
  const first = await submit(running.base, payload);
  expect(first.status).toBe(201);
  const original = await first.json();
  const retry = await submit(running.base, payload);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ ...original, idempotentReplay: true });
  const response = await fetch(
    `${running.base}/wallets/${wallet.walletId}/reconciliation`, { method: 'POST' },
  );
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.consistent).toBe(true);
  expect(result.storedBalance.amount).toBe('75.00');
});
```

Run with `flock ~/.cache/junglegame-db.lock bun test test/integration/provider-contract.test.ts`. For direct persisted-row checks, use [initOrm](test/support/db.ts) and [expectBalanceMatchesLedger](test/support/ledger.ts); close the ORM in teardown.

### Add SQS or external-client integration checks

For SQS tests, follow [queue-consumer.test.ts](test/integration/queue-consumer.test.ts) and the helpers in [queue.ts](test/support/queue.ts):

1. Call `isolateQueues()` before starting the application or consumer. It creates a unique FIFO queue/DLQ pair with the same redrive policy and returns a cleanup function.
2. Open a wallet; construct `requested(dataOf(wallet))`; send it with `send(message, wallet.walletId)`. Start `makeConsumer()` and call `consumer.start()` if the application consumer is not handling it.
3. Poll a persisted outcome with `until(...)`; avoid fixed sleeps. Send the same body again with a fresh transport deduplication ID so the test exercises the inbox rather than only broker deduplication.
4. Assert one financial effect, consistent ledger, and the intended retry/DLQ outcome. Close the consumer/ORM/application, then delete the isolated queues using the cleanup function, including after failures.

For a provider integrating from another language, start the service with `bun start`, import `/docs-json` into the chosen HTTP client, and automate the Swagger flow above against a dedicated test environment. Queue clients use the JSON envelope in the Queue section and AWS SDK SQS commands pointed at `SQS_ENDPOINT`. Preserve `providerId`, `externalTransactionId`, and `idempotencyKey` across retries; use new IDs only for a new operation. Concurrency and recovery checks need multiple connections/processes, beyond a sequence of manual Swagger requests.

## HTTP API
Every endpoint returns errors as `{ code, message }`; responses carry `x-correlation-id` (send `X-Correlation-Id` to choose it). Status and Failure Code meaning: [ARCHITECTURE.md](ARCHITECTURE.md#http-mapping-d20).

| Method and path | Purpose |
|---|---|
| `POST /wallets` | open a Wallet (`playerId` UUID, `initialBalance {amount, currency}`) |
| `GET /wallets/:id` | Balance and `version` |
| `GET /wallets/:id/ledger?cursor=&limit=` | Ledger Entries, oldest first, `limit` 1..200 (default 50) |
| `POST /wallets/:id/reconciliation` | Reconciliation: stored vs rebuilt Balance |
| `POST /wagering/transactions` | submit a Wager Transaction; header `Idempotency-Key` required |
| `GET /wagering/transactions/:transactionId` | one Wager Transaction |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | same, by the Provider's id |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | open (no auth); ready checks PostgreSQL and SQS |

Amounts are strings with exactly 2 decimals (`"80.00"`), never numbers.

## Examples (run against `PORT=20123 bun src/main.ts`)
```bash
B=http://localhost:20123; P=$(uuidgen); R=$(date +%s)   # R keeps keys unique per run (keys are scoped to the Provider, forever)

# 1. Wallet with 100.00 (201)
W=$(curl -s -X POST $B/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$P\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
# 201 {"id":"01a1c8db-...","playerId":"...","balance":{"amount":"100.00","currency":"BRL"},"version":1}

# helper: bet <key> [kind] [amount] [referenceExternalTransactionId]
bet(){ curl -s -w ' [%{http_code}]\n' -X POST $B/wagering/transactions -H 'content-type: application/json' -H "Idempotency-Key: $1" \
  -d "{\"providerId\":\"acme\",\"externalTransactionId\":\"$1\",\"playerId\":\"$P\",\"walletId\":\"$W\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"${2:-BET}\",\"money\":{\"amount\":\"${3:-80.00}\",\"currency\":\"BRL\"}${4:+,\"referenceExternalTransactionId\":\"$4\"}}"; }

# 2. Race: two BETs of 80.00 at once. Exactly one wins (which one varies); the other is REJECTED INSUFFICIENT_FUNDS.
bet $R-bet-1 & bet $R-bet-2 & wait
# {"transactionId":"...","status":"PROCESSED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false} [201]
# {"code":"INSUFFICIENT_FUNDS","message":"Wager Transaction REJECTED: INSUFFICIENT_FUNDS","transactionId":"...","status":"REJECTED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false} [422]

# 3. Replay: same key and payload returns the original result and the Balance seen then, with idempotentReplay true
bet $R-bet-1
# winner: {"status":"PROCESSED","balance":{"amount":"20.00",...},"idempotentReplay":true} [200]; loser: the same 422 as before, replayed

# 4. Same key, different payload (409)
bet $R-bet-1 BET 5.00
# {"code":"IDEMPOTENCY_CONFLICT","message":"Idempotency-Key was already used with a different payload"} [409]

# 5. Out of order: a REFUND whose BET is unknown waits (202); a REFUND of a processed BET applies (201)
bet $R-rf-1 REFUND 80.00 $R-not-yet-sent
# {"transactionId":"...","status":"PENDING_REFERENCE","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false} [202]
bet $R-bet-3 BET 20.00        # Balance 0.00
bet $R-refund-3 REFUND 20.00 $R-bet-3
# {"transactionId":"...","status":"PROCESSED","balance":{"amount":"20.00","currency":"BRL"},"idempotentReplay":false} [201]

# 6. Reconciliation
curl -s -X POST $B/wallets/$W/reconciliation
# {"walletId":"...","storedBalance":{"amount":"100.00","currency":"BRL"},"calculatedBalance":{"amount":"100.00","currency":"BRL"},"difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"checkedEntries":4}

# 7. Ledger page, lookup by Provider id, metrics
curl -s "$B/wallets/$W/ledger?limit=1"      # {"items":[...],"nextCursor":"..."}; pass nextCursor back as ?cursor=
curl -s $B/providers/acme/wagering/transactions/$R-bet-1
curl -s $B/metrics | grep wager_transactions_total
```
`rf-1` in step 5 stays PENDING_REFERENCE until `not-yet-sent` arrives (then it is applied) or about 8.5 minutes pass (then REJECTED `REFERENCE_NOT_FOUND`). Poll it with the `GET` above.

## Queue
Send JSON to `wager-transactions.fifo` (group id = `walletId`): `{"messageId":"<unique>","type":"WagerTransactionRequested","occurredAt":"<iso>","data":{ ...same fields as the HTTP body..., "idempotencyKey":"..." }}`. Optional `correlationId`. Examples: `test/support/queue.ts`. Outcomes and DLQ rules: ARCHITECTURE.md. Confirmed events appear on `wager-events.fifo`.

## Metrics
`wager_transactions_total{status}`, `duplicates_detected_total{source}`, `retries_total{source}`, `dlq_messages_total`, `lock_conflicts_total`, `outbox_lag_seconds`, `processing_duration_seconds`, `reconciliation_divergences_total`. Logs carry `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; amounts and payloads are redacted.

## Development

Tickets live in `.scratch/<feature>/issues/`. Follow the [ticket workflow](docs/development/issue-tracker.md). Use [GLOSSARY.md](GLOSSARY.md) for domain terminology and [docs/adr](docs/adr) for design decisions.
