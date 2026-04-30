export type Symbol = string;
export const EPSILON = 'ε';

export interface State {
  id: string;
  accept: boolean;
  label?: string;
}

export interface Transition {
  from: string;
  to: string;
  symbol: Symbol;
}

export interface NFA {
  states: State[];
  start: string;
  transitions: Transition[];
  alphabet: Symbol[];
}

export function makeState(id: string, accept = false, label?: string): State {
  return { id, accept, label };
}
