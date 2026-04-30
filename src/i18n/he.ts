export const strings = {
  title: 'Automats — מצייר אוטומטים משפה',
  subtitle: 'אתר אוטומטים מדמח אופק רוזנטל',
  emptyHint: 'הקליד שפה כדי לראות את האוטומט.',
  errorHint: 'תקנ את השגיאה כדי לראות את האוטומט.',
  inputLabel: 'תיאור השפה (DSL):',
  exampleLabel: 'דוגמה:',
  exportPng: 'ייצוא PNG',
  exportJson: 'ייצוא JSON',
  showTraps: 'הצג מצבי מלכודת',
  hideTraps: 'הסתר מצבי מלכודת',
  regular: 'רגולרית',
  pda: 'אוטומט מחסנית (PDA)',
  statesLabel: 'מצבים',
  transitionsLabel: 'מעברים',
  stackAlphabetLabel: 'א״ב מחסנית',
  errR2: (varName: string, midVar: string) =>
    `השפה אינה רגולרית: המשתנה '${varName}' מופיע בשני בלוקים לא סמוכים, מופרדים על ידי בלוק עם המשתנה הלא חסום '${midVar}'. שפה כזו דורשת זיכרון מחסנית — נסי PDA (יתמך בעתיד).`,
  errR3Div: `השפה אינה רגולרית: חלוקה (/) של משתנה חופשי דורשת זיכרון מחסנית.`,
  errR4: (a: string, b: string) =>
    `השפה אינה רגולרית: היחס בין '${a}' ל־'${b}' מקשר שני משתנים בלתי חסומים. שפה כזו דורשת זיכרון מחסנית — נסי PDA (יתמך בעתיד).`,
  errPalindrome: (wv: string) =>
    `השפה אינה רגולרית: מופיעה ההיפוך R(${wv}) של משתנה המילה ${wv} שמופיע גם הוא במילה — שפת פלינדרום אינה רגולרית.`,
  errWordVarUnsupported: 'משתני מילה (w, R(w)) עדיין לא נתמכים. נסי שפה בלי משתני מילה.',
  errUnsupported: (reason: string) => `אינו נתמך ב־v1: ${reason}`,
  errUnknownPattern: 'דפוס השפה אינו במאגר הדפוסים הנתמך כרגע. השפה עשויה להיות רגולרית אך הכלי לא יודע לבנות עבורה אוטומט.',

  // Compose mode
  modeSingle: 'שפה יחידה',
  modeCompose: 'הרכבת שפות',
  composeAddLang: 'שפה חדשה',
  composeRemoveLang: 'הסר שפה',
  composeResultLabel: 'ביטוי תוצאה:',
  composeResultPanel: 'תוצאה',
};
