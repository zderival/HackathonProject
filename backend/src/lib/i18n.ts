import { Type } from 'typebox';

export const LANGUAGES = ['en', 'ht', 'fr', 'es', 'ko'] as const;
export type Lang = (typeof LANGUAGES)[number];

export const LangSchema = Type.Union([Type.Literal('en'), Type.Literal('ht'), Type.Literal('fr'), Type.Literal('es'), Type.Literal('ko')], {
  description: 'en (default), ht (Haitian Creole), fr, es, ko',
});

export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && (LANGUAGES as readonly string[]).includes(v);
}

// Picks the first supported language from an Accept-Language header.
// Haitian Creole ("ht") is matched on its own code and never falls back to French.
export function pickLanguage(header: string | undefined, fallback: Lang = 'en'): Lang {
  if (!header) return fallback;
  const tags = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.toLowerCase(), q: q ? Number(q.split('=')[1]) : 1 };
    })
    .filter((t) => t.tag && t.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of tags) {
    const base = tag.split('-')[0];
    if (isLang(base)) return base;
  }
  return fallback;
}
