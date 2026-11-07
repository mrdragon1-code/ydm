/** Sizes, speeds and durations, in the active language's number format. */

import { bcp47, t } from '../i18n';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
let cached: { locale: string; one: Intl.NumberFormat; zero: Intl.NumberFormat } | null = null;

function formats() {
  const locale = bcp47();
  if (cached?.locale !== locale) {
    cached = {
      locale,
      one: new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      zero: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    };
  }
  return cached;
}

/** `1.5 MB`, `12 GB`; binary units, one decimal below 10. */
export function bytes(n: number): string {
  let v = Math.max(0, n);
  let unit = 0;
  while (v >= 1024 && unit < UNITS.length - 1) {
    v /= 1024;
    unit++;
  }
  const f = formats();
  const value = unit === 0 ? f.zero.format(Math.round(v)) : (v < 10 ? f.one : f.zero).format(v);
  return `${value} ${t(`unit.${UNITS[unit]}`)}`;
}

export function speed(bytesPerSecond: number): string {
  return t('unit.perSecond', { value: bytes(bytesPerSecond) });
}

/** `42 s`, `3:07`, `2 h 5 min`. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t('unit.seconds', { s });
  if (s < 3600) return t('unit.minutes', { m: Math.floor(s / 60), ss: String(s % 60).padStart(2, '0') });
  return t('unit.hours', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
}

export function percent(done: number, total: number | null): string {
  return `${Math.floor((done / (total || 1)) * 100)}%`;
}
