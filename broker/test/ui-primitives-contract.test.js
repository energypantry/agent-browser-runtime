import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

test('runtime exposes real UI primitives through extension, broker routes, and extractor context', async () => {
  const [extensionSource, brokerSource] = await Promise.all([
    readFile(new URL('../../extension/background.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  ]);

  for (const method of ['ui.move', 'ui.click', 'ui.type', 'ui.press', 'ui.scroll', 'ui.waitFor']) {
    assert.match(extensionSource, new RegExp(`case '${method.replace('.', '\\.')}':`), `${method} must be dispatched by the extension`);
  }
  for (const cdpInputMethod of ['Input.dispatchMouseEvent', 'Input.insertText', 'Input.dispatchKeyEvent']) {
    assert.match(extensionSource, new RegExp(cdpInputMethod.replace('.', '\\.')), `${cdpInputMethod} must back the UI primitives`);
  }

  for (const route of ['move', 'click', 'type', 'press', 'scroll', 'wait-for']) {
    assert.match(brokerSource, new RegExp(`/tabs/:tabId/ui/${route}`), `broker must expose /tabs/:tabId/ui/${route}`);
  }

  assert.match(brokerSource, /ui:\s*createTabUi\(/, 'extractors must receive a ui helper bound to the owned tab');
});
