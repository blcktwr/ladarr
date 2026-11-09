import { useSyncExternalStore } from 'react';
import { en } from './en.ts';
import { es } from './es.ts';

import type { Language } from '@ladarr/shared/enums';

export type { Language };

// The names of the languages, each in its own language.
export const languages: Record<Language, string> = { en: 'English', es: 'Español' };

const dictionaries: Record<Language, Record<string, string>> = { en, es };
const listeners = new Set<() => void>();
let language: Language = localStorage.getItem('ladarr.language') === 'es' ? 'es' : 'en';
document.documentElement.lang = language;

// The server keeps the language. The browser keeps a copy, so the screens before the sign-in use it too.
export function setLanguage(next: Language) {
  if (next === language) return;
  language = next;
  localStorage.setItem('ladarr.language', next);
  document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}

export const getLanguage = () => language;

// The order of a list item for a person: 1st, 2nd, 3rd in English, 1ro, 2do, 3ro in Spanish.
const ES_ORDINAL = ['mo', 'ro', 'do', 'ro', 'to', 'to', 'to', 'mo', 'vo', 'no'];
export function ordinal(value: number) {
  if (language === 'es') return `${value}${value >= 11 && value <= 19 ? 'vo' : (ES_ORDINAL[value % 10] ?? 'mo')}`;
  const mod100 = value % 100;
  return `${value}${mod100 >= 11 && mod100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][value % 10] ?? 'th')}`;
}

export const useLanguage = () =>
  useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => language,
  );

// The key is the English text. A text that the dictionary does not have shows in English.
// A variable is written as {name} in the key and in the translation.
export function t(key: string, vars?: Record<string, string | number>) {
  const text = dictionaries[language][key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`)) : text;
}
