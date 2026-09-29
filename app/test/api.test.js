import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { createApp } from '../src/app.js';

async function fixture(t, filename = ':memory:') {
  const store = createStore(filename);
  const logs = [];
  const app = createApp({ store, logger: entry => logs.push(entry) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    store.close();
  };
  t.after(close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, store, logs, close, request: (path, options) => fetch(base + path, options) };
}
const product = { name: 'Keyboard', description: 'USB keyboard', priceCents: 2499 };
const body = (value, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

test('product lifecycle: create, list, retrieve, replace, delete', async t => {
  const { request } = await fixture(t);
  const empty = await (await request('/products')).json();
  assert.deepEqual(empty, { items: [], total: 0, limit: 20, offset: 0 });
  const created = await request('/products', body(product));
  assert.equal(created.status, 201);
  const item = await created.json();
  assert.equal(item.name, product.name);
  assert.equal(item.priceCents, 2499);
  assert.ok(item.createdAt);
  assert.equal(created.headers.get('location'), `/products/${item.id}`);
  assert.ok(created.headers.get('x-request-id'));
  assert.deepEqual(await (await request(`/products/${item.id}`)).json(), item);
  const list = await (await request('/products?limit=1&offset=0')).json();
  assert.deepEqual(list.items, [item]);
  assert.equal(list.total, 1);
  assert.equal((await (await request('/products?offset=1')).json()).items.length, 0);
  const updated = await request(`/products/${item.id}`, body({ name: 'Mouse', priceCents: 0 }, 'PUT'));
  assert.equal(updated.status, 200);
  const replacement = await updated.json();
  assert.equal(replacement.name, 'Mouse');
  assert.equal(replacement.description, '');
  assert.equal(replacement.createdAt, item.createdAt);
  assert.equal((await request(`/products/${item.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await request(`/products/${item.id}`)).status, 404);
  assert.equal((await request(`/products/${item.id}`, body(product, 'PUT'))).status, 404);
  assert.equal((await request(`/products/${item.id}`, { method: 'DELETE' })).status, 404);
});

test('invalid input is rejected without storing products', async t => {
  const { request } = await fixture(t);
  for (const invalid of [null, [], {}, { ...product, name: ' ' }, { ...product, name: 'a'.repeat(121) },
    { ...product, priceCents: -1 }, { ...product, priceCents: 1.5 }, { ...product, priceCents: '100' },
    { ...product, priceCents: Number.MAX_SAFE_INTEGER + 1 }, { ...product, description: 2 },
    { ...product, description: 'a'.repeat(2001) }, { ...product, unexpected: true }]) {
    const response = await request('/products', body(invalid));
    assert.equal(response.status, 400, JSON.stringify(invalid));
    const error = await response.json();
    assert.ok(error.error);
    assert.equal(error.requestId, response.headers.get('x-request-id'));
  }
  assert.equal((await (await request('/products')).json()).total, 0);
});

test('malformed JSON, media types, and oversized requests have distinct errors', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await request('/products', { method: 'POST', body: '{}' })).status, 415);
  const tooLarge = await request('/products', body({ ...product, description: 'a'.repeat(17000) }));
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.headers.get('connection'), 'close');
  assert.equal((await request('/health/live')).status, 200);
});

test('routing and pagination errors', async t => {
  const { request } = await fixture(t);
  for (const query of ['limit=0', 'limit=101', 'limit=no', 'offset=-1', 'offset=1.5', 'offset=', 'limit=1e2']) {
    assert.equal((await request(`/products?${query}`)).status, 400, query);
  }
  assert.equal((await request('/products/invalid')).status, 400);
  assert.equal((await request('/unknown')).status, 404);
  const response = await request('/products', { method: 'PATCH' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('health, metrics, structured logs, and graceful draining', async t => {
  const { request, drain, logs } = await fixture(t);
  assert.equal((await (await request('/')).json()).service, 'products-service');
  assert.equal((await request('/health/live')).status, 200);
  assert.equal((await request('/health/ready')).status, 200);
  await request('/products');
  await request('/random-path');
  const response = await request('/metrics');
  assert.match(response.headers.get('content-type'), /text\/plain/);
  const metrics = await response.text();
  assert.match(metrics, /products_http_requests_total\{method="GET",route="\/products",status="200"\} 1/);
  assert.ok(!metrics.includes('random-path'));
  assert.ok(logs.some(entry => entry.requestId && entry.route === '/products'));
  drain();
  assert.equal((await request('/health/ready')).status, 503);
  assert.equal((await request('/products')).status, 503);
  assert.equal((await request('/health/live')).status, 200);
});

test('database failures affect readiness and do not leak internal details', async t => {
  const { store, request } = await fixture(t);
  store.ready = () => { throw new Error('private database detail'); };
  store.list = () => { throw new Error('private database detail'); };
  assert.equal((await request('/health/ready')).status, 503);
  const response = await request('/products');
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, 'Internal server error');
});

test('products survive an application restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'products-service-test-'));
  // Only remove individual files from this test's unique temporary directory.
  t.after(() => {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  const filename = join(directory, 'products.sqlite');
  const first = await fixture(t, filename);
  const item = await (await first.request('/products', body(product))).json();
  await first.close();
  const second = await fixture(t, filename);
  try {
    assert.deepEqual(await (await second.request(`/products/${item.id}`)).json(), item);
  } finally {
    await second.close();
  }
});
