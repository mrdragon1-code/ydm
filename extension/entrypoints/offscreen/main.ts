// Chrome only: hosts the engine, which needs workers and blob URLs that a
// service worker cannot have.
import type { Browser } from 'wxt/browser';
import { Engine } from '@/lib/engine';
import { ENGINE_PORT } from '@/lib/link';
import type { EngineCommand, EngineEvent } from '@/lib/protocol';

let port: Browser.runtime.Port | null = null;
/** Events raised while the service worker restarts; sent once it is back. */
const pending: EngineEvent[] = [];

const engine = new Engine((event) => {
  if (port) port.postMessage(event);
  else pending.push(event);
});

function connect() {
  port = browser.runtime.connect({ name: ENGINE_PORT });
  port.onMessage.addListener((cmd) => engine.handle(cmd as EngineCommand));
  port.onDisconnect.addListener(() => {
    // The service worker was stopped; connecting again wakes it up.
    port = null;
    setTimeout(connect, 100);
  });
  for (const event of pending.splice(0)) port.postMessage(event);
}

connect();
