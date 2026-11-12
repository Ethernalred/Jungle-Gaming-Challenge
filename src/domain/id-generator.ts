import { v7 } from 'uuid';

export abstract class IdGenerator {
  abstract next(): string;
}
export class UuidV7Generator extends IdGenerator {
  next() { return v7(); }
}
