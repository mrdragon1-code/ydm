/**
 * A small XML reader for DASH manifests: elements, attributes and text.
 * The browser's DOMParser does not exist in a service worker or a worker,
 * where manifests are read. Namespaces are dropped from names
 * ("cenc:pssh" → "pssh"); comments, processing instructions, doctypes
 * and CDATA are skipped.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);

export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  // Attributes are matched loosely (quoted values may hold ">"), then read
  // one by one: a malformed one is skipped without losing the element.
  const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE(?:\[[\s\S]*?\]|[^>\[])*>|<![^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/gi;
  let last = 0;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    const text = xml.slice(last, m.index);
    if (text.trim()) stack.at(-1)!.text += decode(text.trim());
    last = tag.lastIndex;
    if (m[1]) {
      // A closing tag: back to the parent (tolerant of mismatches).
      if (stack.length > 1) stack.pop();
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[3] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1]!)] = decode(a[2] ?? a[3] ?? '');
      const el: XmlElement = { name: local(m[2]), attrs, children: [], text: '' };
      stack.at(-1)!.children.push(el);
      if (!m[4]) stack.push(el);
    }
  }
  const top = root.children[0];
  if (!top) throw new Error('not XML');
  return top;
}

/** Direct children called `name`. */
export function kids(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

export function kid(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}
