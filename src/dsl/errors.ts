import type { Span } from './ast';

export class DslError extends Error {
  span?: Span;
  rule?: string;
  constructor(message: string, span?: Span, rule?: string) {
    super(message);
    this.name = 'DslError';
    this.span = span;
    this.rule = rule;
  }
}

export function makeError(message: string, span?: Span, rule?: string): never {
  throw new DslError(message, span, rule);
}
