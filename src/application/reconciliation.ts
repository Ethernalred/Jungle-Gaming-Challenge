import { divergences } from '../infrastructure/metrics/metrics';

/** Divergence counter: `value` is this process's count (tests read it); /metrics exposes the same count. */
export const divergenceCounter = {
  value: 0,
  inc() { this.value += 1; divergences.inc(); },
};
