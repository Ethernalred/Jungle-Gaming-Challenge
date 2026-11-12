import { v7 as uuid } from 'uuid';
import { runWith } from '../../application/context';

/** D28: correlationId = X-Correlation-Id header (sane values only) or generated; echoed in the response. */
export function correlationMiddleware(req: any, res: any, next: () => void) {
  const h = req.headers['x-correlation-id'];
  const correlationId = typeof h === 'string' && /^[\w.:-]{1,128}$/.test(h) ? h : uuid();
  res.setHeader('x-correlation-id', correlationId);
  runWith({ correlationId }, next);
}
