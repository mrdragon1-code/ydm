/** The "paste links" form, shared by the popup and the app. */

import { t } from '../i18n';
import { expandPatterns, MAX_EXPANDED } from '../batch';
import { parseUrls } from '../links';
import type { PopupCommand } from '../protocol';

export function wireAdder(
  toggle: HTMLButtonElement,
  form: HTMLFormElement,
  field: HTMLTextAreaElement,
  status: HTMLElement,
  send: (cmd: PopupCommand) => void,
  /** A screenshot pasted or dropped in the field: read its links. */
  onImage?: (image: Blob) => void,
) {
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) field.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // Ranges like photo[001-120].jpg are spelled out first: as a URL the
    // brackets would be encoded and lost.
    const expanded = expandPatterns(field.value);
    const found = parseUrls(expanded.text);
    status.textContent = !found.length
      ? t('popup.addInvalid')
      : expanded.truncated
        ? t('popup.addTruncated', { count: found.length, max: MAX_EXPANDED })
        : t('popup.addDone', { count: found.length });
    if (!found.length) return;
    send({ type: 'urls', urls: found });
    field.value = '';
  });
  if (onImage) {
    const imageIn = (data: DataTransfer | null) => [...(data?.files ?? [])].find((f) => f.type.startsWith('image/'));
    field.addEventListener('paste', (e) => {
      const image = imageIn(e.clipboardData);
      if (!image) return;
      e.preventDefault();
      onImage(image);
    });
    field.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file' && i.type.startsWith('image/'))) e.preventDefault();
    });
    field.addEventListener('drop', (e) => {
      const image = imageIn(e.dataTransfer);
      if (!image) return;
      e.preventDefault();
      onImage(image);
    });
  }
  // Ctrl/Cmd+Enter sends, Enter alone makes a new line.
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
  });
}

/** Arrow keys move the choice in a radiogroup, as for native radios. */
export function wireRadioKeys(group: HTMLElement, choose: (button: HTMLButtonElement) => void) {
  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const at = buttons.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + step))];
    if (!next || next === buttons[at]) return;
    e.preventDefault();
    choose(next);
    next.focus();
  });
}
