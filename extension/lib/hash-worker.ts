/**
 * Hashes a finished download while the browser copies it to Downloads.
 * Reads the OPFS file in slices, so memory stays small for any size.
 */

import { Sha256 } from './sha256';

const SLICE = 4 << 20;

const scope = self as unknown as {
  postMessage(msg: { sha256: string } | { error: string }): void;
  onmessage: ((e: MessageEvent<{ file: string }>) => void) | null;
};

scope.onmessage = async (e) => {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('ydm');
    const file = await (await dir.getFileHandle(e.data.file)).getFile();
    const hash = new Sha256();
    for (let at = 0; at < file.size; at += SLICE) {
      hash.update(new Uint8Array(await file.slice(at, at + SLICE).arrayBuffer()));
    }
    scope.postMessage({ sha256: hash.hex() });
  } catch (err) {
    scope.postMessage({ error: String(err) });
  }
};
