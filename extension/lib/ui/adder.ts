/** The "paste links" form, shared by the popup and the app. */

import { t } from '../i18n';
import { parseUrls } from '../links';
import type { PopupCommand } from '../protocol';

export function wireAdder(
  toggle: HTMLButtonElement,
  form: HTMLFormElement,
  field: HTMLTextAreaElement,
  status: HTMLElement,
  send: (cmd: PopupCommand) => void,
) {
  toggle.addEventListener('click', () => {
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) field.focus();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const found = parseUrls(field.value);
    status.textContent = found.length ? t('popup.addDone', { count: found.length }) : t('popup.addInvalid');
    if (!found.length) return;
    send({ type: 'urls', urls: found });
    field.value = '';
  });
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
