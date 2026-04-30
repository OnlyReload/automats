import type { NFA } from '../automaton/types';
import type { PDA } from '../automaton/pda';
import { describeAction } from '../automaton/pda';

type Automaton = NFA | PDA;

function isPDA(a: Automaton): a is PDA {
  return (a as PDA).kind === 'pda';
}

export function exportJson(a: Automaton, langName = 'automaton'): void {
  let payload: object;
  if (isPDA(a)) {
    payload = {
      name: langName,
      type: 'PDA',
      states: a.states.map((s) => ({ id: s.id, accept: s.accept })),
      start: a.start,
      initialStack: a.initialStack,
      inputAlphabet: a.inputAlphabet,
      stackAlphabet: a.stackAlphabet,
      transitions: a.transitions.map((t) => ({
        from: t.from,
        to: t.to,
        inputSymbol: t.inputSymbol,
        stackTop: t.stackTop,
        action: { ...t.action, label: describeAction(t.action) },
      })),
    };
  } else {
    payload = {
      name: langName,
      type: 'NFA',
      states: a.states.map((s) => ({ id: s.id, accept: s.accept })),
      start: a.start,
      alphabet: a.alphabet,
      transitions: a.transitions,
    };
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${langName}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
