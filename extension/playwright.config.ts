import { defineConfig } from '@playwright/test';

// End-to-end tests: the built extension in a real Chromium, downloading from
// the local test server (engine/crates/ydm-testserver). Run `npm run build`
// and `cargo build --release -p ydm-testserver` first.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
});
