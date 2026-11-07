/**
 * How the background reaches the engine. Chrome's service worker cannot
 * start workers, so the engine runs in an offscreen document created on
 * demand and closed when idle. Firefox's background page can host it
 * directly.
 */

import type { Browser } from 'wxt/browser';
import { Engine } from './engine';
import type { EngineCommand, EngineEvent } from './protocol';

export interface EngineLink {
  send(cmd: EngineCommand): Promise<void>;
  /** Stops the engine and frees its memory; only call when nothing runs. */
  close(): Promise<void>;
  /** Whether a previous engine is still running (after a service worker restart). */
  alive(): Promise<boolean>;
}

export function createLink(onEvent: (e: EngineEvent) => void): EngineLink {
  return import.meta.env.FIREFOX ? new LocalLink(onEvent) : new OffscreenLink(onEvent);
}

export const ENGINE_PORT = 'engine';

class OffscreenLink implements EngineLink {
  private port: Browser.runtime.Port | null = null;
  private waiting: ((port: Browser.runtime.Port) => void)[] = [];

  constructor(onEvent: (e: EngineEvent) => void) {
    // Registered at startup, so a reconnecting engine page is never missed.
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== ENGINE_PORT || port.sender?.id !== browser.runtime.id) return;
      this.port = port;
      port.onMessage.addListener((msg) => onEvent(msg as EngineEvent));
      port.onDisconnect.addListener(() => {
        if (this.port === port) this.port = null;
      });
      for (const resolve of this.waiting.splice(0)) resolve(port);
    });
  }

  async send(cmd: EngineCommand) {
    (await this.connect()).postMessage(cmd);
  }

  async close() {
    this.port = null;
    if (await this.alive()) await browser.offscreen.closeDocument();
  }

  async alive() {
    return browser.offscreen.hasDocument();
  }

  private async connect(): Promise<Browser.runtime.Port> {
    if (this.port) return this.port;
    const connected = new Promise<Browser.runtime.Port>((resolve) => this.waiting.push(resolve));
    if (!(await this.alive())) {
      await browser.offscreen
        .createDocument({
          url: browser.runtime.getURL('/offscreen.html'),
          reasons: [browser.offscreen.Reason.WORKERS, browser.offscreen.Reason.BLOBS],
          justification: 'Runs downloads in a worker and hands the finished file to the browser.',
        })
        // Two sends racing: the other one created it.
        .catch(() => {});
    }
    return connected;
  }
}

class LocalLink implements EngineLink {
  private engine: Engine | null = null;

  constructor(private onEvent: (e: EngineEvent) => void) {}

  async send(cmd: EngineCommand) {
    this.engine ??= new Engine(this.onEvent);
    this.engine.handle(cmd);
  }

  async close() {
    this.engine = null;
  }

  async alive() {
    return this.engine !== null;
  }
}
