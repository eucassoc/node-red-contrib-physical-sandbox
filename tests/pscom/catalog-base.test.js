import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleUrl, meshUrl, loadMachineIndex, forgetBundles, setCatalogBase } from '../../src/pscom/catalog-client.js';

const REF = 'physical-sandbox/arm:1';

test.afterEach(() => {
  setCatalogBase('');
  forgetBundles();
});

test('the default stays root-relative', async () => {
  forgetBundles();
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => ({ bundle: 'robot.json' }) }; };
  assert.equal(await bundleUrl(REF, fetchImpl), '/api/catalog/physical-sandbox/arm/1/files/robot.json');
  assert.deepEqual(urls, ['/api/catalog/physical-sandbox/arm/1/manifest']);
});

test('setCatalogBase puts the base in front of every catalog URL', async () => {
  setCatalogBase('/physical-sandbox/catalog/');
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return { ok: true, json: async () => ({ bundle: 'a/robot.json', items: [] }) }; };
  assert.equal(await bundleUrl(REF, fetchImpl), '/physical-sandbox/catalog/api/catalog/physical-sandbox/arm/1/files/a/robot.json');
  assert.equal(meshUrl(REF, 'm.bin'), '/physical-sandbox/catalog/api/catalog/physical-sandbox/arm/1/files/a/m.bin');
  await loadMachineIndex(fetchImpl);
  assert.ok(urls.length >= 2 && urls.every((url) => url.startsWith('/physical-sandbox/catalog/api/catalog/')), urls.join('\n'));
});

test('the fetch given to setCatalogBase is used when a caller passes none', async () => {
  const urls = [];
  setCatalogBase('http://x', async (url) => { urls.push(url); return { ok: true, json: async () => ({ bundle: 'robot.json' }) }; });
  await bundleUrl(REF);
  assert.deepEqual(urls, ['http://x/api/catalog/physical-sandbox/arm/1/manifest']);
});
