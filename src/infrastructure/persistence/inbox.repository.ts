import { MikroORM } from '@mikro-orm/postgresql';
import { DomainError } from '../../domain/errors';

/** The message was already committed by an earlier delivery: roll back this one and ack. */
export class InboxDuplicate extends DomainError {}
/** The same messageId arrived with a different payload (D25): permanent. */
export class InboxHashMismatch extends DomainError {}

export class InboxRepository {
  constructor(private readonly orm: MikroORM) {}

  /**
   * Records the message in the inbox. Must be called inside the DB transaction of the Wager Transaction (it joins that
   * transaction through MikroORM's transaction context), so the inbox row commits or rolls back with the change.
   * Throws InboxDuplicate (same hash) or InboxHashMismatch (different hash) when the messageId is known.
   */
  async record(consumerName: string, messageId: string, hash: string): Promise<void> {
    const em = this.orm.em.getContext();
    const rows = await em.execute(
      'insert into inbox (consumer_name, message_id, payload_hash) values (?, ?, ?) on conflict do nothing returning message_id',
      [consumerName, messageId, hash]);
    if (rows.length) return;
    const [known] = await em.execute('select payload_hash from inbox where consumer_name = ? and message_id = ?', [consumerName, messageId]);
    throw known.payload_hash === hash ? new InboxDuplicate('Message already processed') : new InboxHashMismatch('messageId reused with a different payload');
  }
}
