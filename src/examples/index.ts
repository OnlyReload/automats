export interface Example {
  id: string;
  label: string;
  source: string;
  note?: string;
}

/**
 * Curated 4-example dropdown — three regular (NFA), one pushdown (PDA),
 * picked to span the most pedagogically interesting shapes:
 *   NFA: independent blocks, modular cross-vars, single-var modular.
 *   PDA: classic equal-counts.
 */
export const EXAMPLES: Example[] = [
  // ── Regular (NFA) ──────────────────────────────────────────────────────
  {
    id: 'L4',
    label: 'L₄ — { aⁿ bᵐ | n,m ≥ 0 }',
    source: 'L4 = { a^n b^m | n >= 0, m >= 0 }',
    note: 'בלוקים בלתי תלויים — שני מצבים מקבלים',
  },
  {
    id: 'L3',
    label: 'L₃ — { aⁿ c² bᵐ | n%3 = m, m,n ≥ 0 }',
    source: 'L3 = { a^n c^2 b^m | n%3 = m, m >= 0, n >= 0 }',
    note: 'דפוס מודולרי — מחזור 3 על a, סניף לכל שארית',
  },
  {
    id: 'a-mod',
    label: '{ aⁿ | n%3 = 1 }',
    source: 'L = { a^n | n%3 = 1, n >= 0 }',
    note: 'מודולו על משתנה יחיד — מחזור 3 מצבים',
  },

  // ── Non-regular but context-free (PDA) ─────────────────────────────────
  {
    id: 'a^n_b^n',
    label: '{ aⁿ bⁿ | n ≥ 0 } (PDA)',
    source: 'L = { a^n b^n | n >= 0 }',
    note: 'הקלאסי — דחיפה בכל a, שליפה בכל b',
  },
];
