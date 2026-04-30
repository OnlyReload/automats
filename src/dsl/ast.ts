export type Span = { start: number; end: number };

export interface Node {
  span: Span;
}

export type ArithExpr =
  | (Node & { kind: 'int'; value: number })
  | (Node & { kind: 'var'; name: string })
  | (Node & { kind: 'binop'; op: '+' | '-' | '*' | '/' | '%'; left: ArithExpr; right: ArithExpr });

export type Atom =
  | (Node & { kind: 'symbol'; symbol: string })
  | (Node & { kind: 'group'; word: Word })
  | (Node & { kind: 'wordVar'; name: string })
  | (Node & { kind: 'reverse'; wordVar: string });

export interface Term extends Node {
  kind: 'term';
  atom: Atom;
  exponent: ArithExpr | null;
}

export interface Word extends Node {
  kind: 'word';
  terms: Term[];
}

export type RelOp = '=' | '>=' | '<=' | '>' | '<';

export type Constraint =
  | (Node & {
      kind: 'rel';
      operands: ArithExpr[];
      ops: RelOp[];
    })
  | (Node & {
      kind: 'wordVarDecl';
      wordVar: string;
      alphabet: string[];
    });

export interface LangDecl extends Node {
  kind: 'langDecl';
  name: string;
  word: Word;
  constraints: Constraint[];
}
