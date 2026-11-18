/**
 * Runs downloads, one worker each. Lives in a page with DOM access: the
 * offscreen document in Chrome, the background page in Firefox. The queue
 * and the list belong to the background; this only executes.
 */

import DownloadWorker from './download-worker?worker';
import HashWorker from './hash-worker?worker';
import StreamWorker from './stream-worker?worker';
import type { EngineCommand, EngineEvent, WorkerEvent } from './protocol';

const DIR = 'ydm';

interface Job {
  worker?: Worker;
  blobUrl?: string;
  /** Latest speed limit, also when it changes before the worker starts. */
  limit?: number;
  /** Latest connection budget, also when it changes before the worker starts. */
  max?: number;
  /** Paused: keep the partial file when the worker stops. */
  keep?: boolean;
  checksum?: boolean;
  /** Hold the finished file for the background's security check. */
  inspect?: boolean;
  /** Hash it before the check (online lookups need it), not while saving. */
  hashFirst?: boolean;
  /** The file is deleted once both the browser's copy and the hash are done. */
  copied?: boolean;
  hashing?: Promise<void>;
}

/** First bytes kept for the check: enough to tell a program from a document. */
const HEAD = 64;

export class Engine {
  private jobs = new Map<number, Job>();
  /** Downloads start only after the leftovers are gone. */
  private cleaned: Promise<void> = Promise.resolve();

  constructor(private emit: (event: EngineEvent) => void) {}

  handle(cmd: EngineCommand) {
    switch (cmd.type) {
      case 'add':
        return void this.start(cmd);
      case 'cancel': {
        const job = this.jobs.get(cmd.id);
        if (job) job.keep = cmd.keep;
        return job?.worker?.postMessage({ type: 'cancel' });
      }
      case 'limit': {
        const job = this.jobs.get(cmd.id);
        if (job) job.limit = cmd.bytesPerSecond;
        return job?.worker?.postMessage({ type: 'limit', bytesPerSecond: cmd.bytesPerSecond });
      }
      case 'connections': {
        const job = this.jobs.get(cmd.id);
        if (job) job.max = cmd.max;
        return job?.worker?.postMessage({ type: 'connections', max: cmd.max });
      }
      case 'proceed':
        return this.jobs.get(cmd.id)?.worker?.postMessage({ type: 'proceed' });
      case 'deliver':
        // The name comes along: after a restart the engine no longer has it.
        return void this.deliver(cmd.id, cmd.name, cmd.checksum);
      case 'release': {
        // The browser has its copy; the hash may still be reading the file.
        const job = this.jobs.get(cmd.id);
        if (job?.hashing) {
          job.copied = true;
          return void job.hashing.then(() => this.release(cmd.id));
        }
        return void this.release(cmd.id);
      }
      case 'prune':
        // Partial files of downloads that will not be resumed.
        this.cleaned = this.removeExcept(new Set(cmd.keep.map(fileName)));
        return;
    }
  }

  private async start({ id, url, name, connections, hint, mirrors, resume, limit, checksum, inspect, hashFirst, kind }: Extract<EngineCommand, { type: 'add' }>) {
    const worker = kind ? new StreamWorker() : new DownloadWorker();
    const job: Job = { worker, limit, max: connections, checksum, inspect, hashFirst };
    this.jobs.set(id, job);
    await this.cleaned;
    worker.onmessage = (e: MessageEvent<WorkerEvent>) => void this.onWorker(id, e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      this.stop(id);
      this.emit({ type: 'failed', id, reason: { key: 'reason.engine', params: { detail: e.message || 'worker' } }, retryInBrowser: true });
      void this.release(id);
    };
    worker.postMessage({ type: 'start', url, name, connections: job.max ?? connections, hint, mirrors, file: fileName(id), resume, limit: job.limit, kind });
  }

  private async onWorker(id: number, msg: WorkerEvent) {
    switch (msg.type) {
      case 'started':
      case 'capped':
      case 'tuned':
      case 'mirrors':
      case 'progress':
      case 'checkpoint':
      case 'origins':
        return this.emit({ ...msg, id });
      case 'done': {
        const { inspect, checksum, hashFirst } = this.jobs.get(id) ?? {};
        this.stop(id);
        try {
          if (inspect) {
            // Held until checked: nothing reaches the Downloads folder yet.
            const file = await (await (await this.dir()).getFileHandle(fileName(id))).getFile();
            const head = [...new Uint8Array(await file.slice(0, HEAD).arrayBuffer())];
            // Reading a large file twice is slow: hashed first only when an
            // online service will be asked about it; otherwise while saving.
            const sha256 = hashFirst ? await this.hash(id) : null;
            // Kept on disk, no worker: `deliver` or `release` comes next.
            this.jobs.delete(id);
            if (sha256 && checksum) this.emit({ type: 'hashed', id, sha256 });
            this.emit({ type: 'inspected', id, name: msg.name, sha256, head });
            return;
          }
          // A disk-backed blob: the browser copies it without loading it in memory.
          const file = await (await this.dir()).getFileHandle(fileName(id));
          const blobUrl = URL.createObjectURL(await file.getFile());
          const done: Job = { blobUrl };
          if (checksum) {
            done.hashing = this.hash(id).then((sha256) => {
              if (sha256) this.emit({ type: 'hashed', id, sha256 });
            });
          }
          this.jobs.set(id, done);
          this.emit({ type: 'ready', id, name: msg.name, blobUrl });
        } catch (e) {
          this.emit({ type: 'failed', id, reason: { key: 'reason.engine', params: { detail: String(e) } }, retryInBrowser: true });
          await this.release(id);
        }
        return;
      }
      case 'failed':
        this.stop(id);
        await this.release(id);
        return this.emit({ type: 'failed', id, reason: msg.reason, retryInBrowser: msg.retryInBrowser });
      case 'cancelled': {
        const keep = this.jobs.get(id)?.keep;
        this.stop(id);
        if (keep) this.jobs.delete(id);
        else await this.release(id);
        return this.emit({ type: 'cancelled', id });
      }
    }
  }

  /** A held file, allowed: the browser copies it to Downloads now. */
  private async deliver(id: number, name: string, checksum?: boolean) {
    await this.cleaned;
    try {
      const file = await (await this.dir()).getFileHandle(fileName(id));
      const blobUrl = URL.createObjectURL(await file.getFile());
      const job: Job = { blobUrl };
      // Not hashed before the check: hashed now, while the browser copies it.
      if (checksum) {
        job.hashing = this.hash(id).then((sha256) => {
          if (sha256) this.emit({ type: 'hashed', id, sha256 });
        });
      }
      this.jobs.set(id, job);
      this.emit({ type: 'ready', id, name, blobUrl });
    } catch (e) {
      this.emit({ type: 'failed', id, reason: { key: 'reason.engine', params: { detail: String(e) } }, retryInBrowser: true });
      await this.release(id);
    }
  }

  /** SHA-256 of a finished file, in its own worker. `null` if it could not
   * be read: then no hash is shown, and online checks cannot ask about it. */
  private hash(id: number): Promise<string | null> {
    return new Promise((resolve) => {
      const worker = new HashWorker();
      const finish = (sha256: string | null) => {
        worker.terminate();
        resolve(sha256);
      };
      worker.onmessage = (e: MessageEvent<{ sha256?: string }>) => finish(e.data.sha256 ?? null);
      worker.onerror = (e) => {
        e.preventDefault();
        finish(null);
      };
      worker.postMessage({ file: fileName(id) });
    });
  }

  private stop(id: number) {
    const job = this.jobs.get(id);
    job?.worker?.terminate();
    if (job) job.worker = undefined;
  }

  private async release(id: number) {
    const job = this.jobs.get(id);
    if (job?.blobUrl) URL.revokeObjectURL(job.blobUrl);
    this.jobs.delete(id);
    const dir = await this.dir().catch(() => null);
    if (!dir) return;
    // A stream also leaves its tracks beside the file ("<id>.part.t0", …).
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) if (name === fileName(id) || name.startsWith(`${fileName(id)}.`)) await dir.removeEntry(name).catch(() => {});
  }

  private async removeExcept(keep: Set<string>) {
    try {
      const dir = await this.dir();
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      // A kept download keeps its stream's tracks too ("<id>.part.t0", …).
      for (const name of names) if (!keep.has(name.replace(/^(\d+\.part)\..*$/, '$1'))) await dir.removeEntry(name).catch(() => {});
    } catch {
      // Nothing to clean.
    }
  }

  private async dir() {
    return (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
  }
}

function fileName(id: number) {
  return `${id}.part`;
}
