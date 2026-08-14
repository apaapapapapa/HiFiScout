/**
 * Typed element lookups and event-target narrowing.
 *
 * The markup is served from `public/index.html`, so a missing id is a deployment bug rather than
 * a runtime condition to handle — these throw instead of returning null and letting a later
 * property access fail somewhere less obvious.
 */

export function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element;
}

export const $ = requireElement;

export function $input(id: string): HTMLInputElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLInputElement)) throw new TypeError(`#${id} is not an <input>`);
  return element;
}

export function $select(id: string): HTMLSelectElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLSelectElement)) throw new TypeError(`#${id} is not a <select>`);
  return element;
}

export function $dialog(id: string): HTMLDialogElement {
  const element = requireElement(id);
  if (!(element instanceof HTMLDialogElement)) throw new TypeError(`#${id} is not a <dialog>`);
  return element;
}

/** Filter controls addressed by id: every one of them is an `<input>` or a `<select>`. */
export function $field(id: string): HTMLInputElement | HTMLSelectElement {
  const element = requireElement(id);
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) return element;
  throw new TypeError(`#${id} is not a form field`);
}

export function eventElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

export function closestElement(target: Element, selector: string): HTMLElement | null {
  const found = target.closest(selector);
  return found instanceof HTMLElement ? found : null;
}

export function closestButton(target: Element, selector: string): HTMLButtonElement | null {
  const found = target.closest(selector);
  return found instanceof HTMLButtonElement ? found : null;
}
