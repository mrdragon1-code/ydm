/**
 * Runs downloads, one worker each. Lives in a page with DOM access: the
 * offscreen document in Chrome, the background page in Firefox. The queue
 * and the list belong to the background; this only executes.
 */

import DownloadWorker from './download-worker?worker';
import type { EngineCommand, EngineEvent, WorkerEvent } from './protocol';

const DIR = 'ydm';

interface Job {
  worker?: Worker;
  blobUrl?: string;
  /** Latest speed limit, also when it changes before the worker starts. */
  limit?: number;
  /** Paused: keep the partial file when the worker stops. */
  keep?: boolean;
}

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
      case 'release':
        return void this.release(cmd.id);
      case 'prune':
        // Partial files of downloads that will not be resumed.
        this.cleaned = this.removeExcept(new Set(cmd.keep.map(fileName)));
        return;
    }
  }

  private async start({ id, url, name, connections, resume, limit }: Extract<EngineCommand, { type: 'add' }>) {
    const worker = new DownloadWorker();
    const job: Job = { worker, limit };
    this.jobs.set(id, job);
    await this.cleaned;
    worker.onmessage = (e: MessageEvent<WorkerEvent>) => void this.onWorker(id, e.data);
    worker.onerror = (e) => {
      e.preventDefault();
      this.stop(id);
      this.emit({ type: 'failed', id, reason: { key: 'reason.engine', params: { detail: e.message || 'worker' } }, retryInBrowser: true });
      void this.release(id);
    };
    worker.postMessage({ type: 'start', url, name, connections, file: fileName(id), resume, limit: job.limit });
  }

  private async onWorker(id: number, msg: WorkerEvent) {
    switch (msg.type) {
      case 'started':
      case 'progress':
      case 'checkpoint':
        return this.emit({ ...msg, id });
      case 'done': {
        this.stop(id);
        try {
          // A disk-backed blob: the browser copies it without loading it in memory.
          const file = await (await this.dir()).getFileHandle(fileName(id));
          const blobUrl = URL.createObjectURL(await file.getFile());
          this.jobs.set(id, { blobUrl });
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

  private stop(id: number) {
    const job = this.jobs.get(id);
    job?.worker?.terminate();
    if (job) job.worker = undefined;
  }

  private async release(id: number) {
    const job = this.jobs.get(id);
    if (job?.blobUrl) URL.revokeObjectURL(job.blobUrl);
    this.jobs.delete(id);
    try {
      await (await this.dir()).removeEntry(fileName(id));
    } catch {
      // Already gone.
    }
  }

  private async removeExcept(keep: Set<string>) {
    try {
      const dir = await this.dir();
      const names: string[] = [];
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
      for (const name of names) if (!keep.has(name)) await dir.removeEntry(name).catch(() => {});
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
