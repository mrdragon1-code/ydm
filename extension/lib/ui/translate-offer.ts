/**
 * When the browser's language is not one YDM ships, pages offer to
 * translate YDM with the browser's own on-device translator. If the
 * language pack is already on the device it happens at once; otherwise
 * Chrome needs a click to download it, so a small banner asks.
 */

import { bcp47, LOCALES, setLocale, t, translatePage } from '../i18n';
import { cachedTranslation, translateCatalog, translatorStatus } from '../translate';

let running = false;

/** `lang`: the language pages should show. `onReady` re-renders them. */
export async function offerTranslation(lang: string, onReady: () => void): Promise<void> {
  document.getElementById('ydm-translate')?.remove();
  if (running || LOCALES.includes(lang)) return;
  if (await cachedTranslation(lang)) return;
  const status = await translatorStatus(lang);
  if (status === 'unavailable') return;
  if (status === 'available') return void run(lang, onReady, null);

  const banner = document.createElement('div');
  banner.id = 'ydm-translate';
  banner.className = 'translate-offer';
  banner.setAttribute('role', 'region');
  const text = document.createElement('span');
  text.textContent = t('translate.offer', { language: languageName(lang) });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button';
  button.textContent = t('translate.button');
  // The click is the user activation Chrome needs to fetch the language pack.
  button.addEventListener('click', () => void run(lang, onReady, banner));
  banner.append(text, button);
  document.body.prepend(banner);
}

async function run(lang: string, onReady: () => void, banner: HTMLElement | null) {
  running = true;
  const status = banner?.querySelector('span');
  banner?.querySelector('button')?.remove();
  try {
    await translateCatalog(lang, (done, total) => {
      if (status) status.textContent = t('translate.progress', { pct: `${Math.floor((done / total) * 100)}%` });
    });
    await setLocale(lang);
    translatePage();
    banner?.remove();
    onReady();
  } catch {
    if (status) status.textContent = t('translate.failed');
  } finally {
    running = false;
  }
}

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([bcp47(code)], { type: 'language' }).of(bcp47(code)) ?? code;
  } catch {
    return code;
  }
}
