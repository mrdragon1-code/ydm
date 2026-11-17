// Whether Firefox has finished saving a file, for the Firefox tests.
//
// Firefox creates the final file empty, then a ".part" beside it, writes
// the ".part" and renames it at the end. Between the first two steps the
// final file exists and no ".part" does: a check there reads an empty or
// partial file. A file counts as saved only when it has its full size, no
// ".part" is left, and it is unchanged on the next look.

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function savedWatcher(dir, name, size) {
  let seen = -1;
  return () => {
    const file = path.join(dir, name);
    if (!existsSync(file) || readdirSync(dir).some((f) => f.endsWith('.part'))) return (seen = -1), false;
    const now = statSync(file).size;
    const stable = now === size && seen === size;
    seen = now;
    return stable;
  };
}
