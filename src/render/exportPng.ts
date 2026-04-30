import { getActiveCy } from './Graph';

export function exportPng(filename = 'automaton.png'): void {
  const cy = getActiveCy();
  if (!cy) return;
  const png64 = cy.png({
    full: true,
    scale: 2,
    bg: '#0e0f13',
  });
  const a = document.createElement('a');
  a.href = png64;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
