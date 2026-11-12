import { MikroORM } from '@mikro-orm/postgresql';
import ormConfig from '../../src/infrastructure/persistence/orm.config';

export const initOrm = () => MikroORM.init({ ...ormConfig, debug: false });
