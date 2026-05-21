import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

test('runtime exposes continuous browsing commands that reuse one lease tab', async () => {
  const [brokerSource, cliSource] = await Promise.all([
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
    readFile(new URL('../../cli/brs.js', import.meta.url), 'utf8'),
  ]);

  assert.match(brokerSource, /\/tabs\/:tabId\/fetch-page/, 'broker must expose tab-scoped fetch-page reuse');
  assert.match(brokerSource, /store\.getTab\(tabId\)/, 'tab-scoped fetch must resolve the tracked tab');
  assert.match(brokerSource, /TAB_LEASE_MISMATCH/, 'tab-scoped fetch must reject mismatched lease ids');
  assert.match(brokerSource, /store\.updateTab\(tabId/, 'navigation must update tracked tab state');

  for (const command of ['browse-start', 'browse-nav', 'browse-html', 'browse-screenshot', 'browse-end']) {
    assert.match(cliSource, new RegExp(`cmd === '${command}'`), `CLI must expose ${command}`);
  }

  assert.match(cliSource, /options\.leaseId \|\| options\.lease/, 'fetch must accept a reusable lease id');
  assert.match(cliSource, /options\.tabId \|\| options\.tab/, 'fetch must accept a reusable tab id');
  assert.match(cliSource, /\/tabs\/\$\{encodeURIComponent\(tabId\)\}\/fetch-page/, 'fetch reuse path must call tab-scoped fetch-page');
});
