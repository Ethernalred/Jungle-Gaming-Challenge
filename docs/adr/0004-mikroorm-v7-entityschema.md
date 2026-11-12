# MikroORM v7 with EntitySchema, no entity decorators

We use MikroORM (the spec's preferred ORM) v7 with `EntitySchema` definitions and mapper functions instead of decorated entity classes. This keeps the domain classes free of ORM code (they have private constructors and `rehydrate` factories), and it avoids Bun's known bugs with decorator metadata and stack-trace parsing that have broken MikroORM's decorator path more than once. TypeORM was not kept as a fallback: it depends even more on decorator metadata under Bun.

## Consequences

Every property needs an explicit type, entities are listed explicitly (no globs), and the CLI must run as `bunx --bun mikro-orm` or it silently runs under Node.
