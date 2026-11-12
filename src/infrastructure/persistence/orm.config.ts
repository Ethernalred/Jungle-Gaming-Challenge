import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { migrationsList } from './migrations';
import { schemas } from './schemas';

export const databaseUrl = process.env.DATABASE_URL ?? 'postgres://jungle:jungle@localhost:55432/jungle';

export const appDatabaseUrl = process.env.APP_DATABASE_URL ?? 'postgres://jungle_app:jungle_app@localhost:55432/jungle';

const config = defineConfig({
  clientUrl: databaseUrl,
  entities: schemas,
  extensions: [Migrator],
  migrations: { migrationsList, path: 'src/infrastructure/persistence/migrations', snapshot: false },
  discovery: { warnWhenNoEntities: false },
});

export default config;

// Config the running app uses: restricted role (D17). Migrations/CLI/tests-with-raw-SQL use the default (owner) config.
export const appOrmConfig = { ...config, clientUrl: appDatabaseUrl };
