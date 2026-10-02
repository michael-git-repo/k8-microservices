import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/studio.css', ['studio.css', 'text/css']],
  ['/dashboard.js', ['dashboard.js', 'text/javascript']],
].map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(`../public/${file}`, import.meta.url)) }]));

const MAX_BODY_BYTES = 16 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readProduct(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks = [];
  // Keep the socket alive long enough to return a useful 413 response.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      throw new HttpError(413, 'Request body must not exceed 16 KiB');
    }
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Request body must be valid JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new HttpError(400, 'Request body must be an object');
  }
  if (Object.keys(value).some(key => !['name', 'description', 'priceCents'].includes(key))) {
    throw new HttpError(400, 'Allowed fields: name, description, priceCents');
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 120) {
    throw new HttpError(400, 'name must contain 1 to 120 characters');
  }
  if (!Number.isSafeInteger(value.priceCents) || value.priceCents < 0) {
    throw new HttpError(400, 'priceCents must be a non-negative safe integer');
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 2000)) {
    throw new HttpError(400, 'description must be a string of at most 2000 characters');
  }
  return { name: value.name.trim(), description: value.description ?? '', priceCents: value.priceCents };
}

function queryInteger(url, name, fallback, min, max) {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function createApp({ store, logger = entry => console.log(JSON.stringify(entry)) }) {
  const counts = new Map();
  let draining = false;
  const server = createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    let route = 'unmatched';
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.on('finish', () => {
      const method = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'].includes(req.method) ? req.method : 'OTHER';
      const key = `method="${method}",route="${route}",status="${res.statusCode}"`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      logger({ level: 'info', requestId, method, route, status: res.statusCode, durationMs: Math.round((performance.now() - started) * 100) / 100 });
    });
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const allow = methods => {
      if (!methods.includes(req.method)) {
        res.setHeader('Allow', methods.join(', '));
        throw new HttpError(405, 'Method not allowed');
      }
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (assets.has(path)) {
        route = path;
        allow(['GET', 'HEAD']);
        const asset = assets.get(path);
        res.writeHead(200, {
          'Content-Type': `${asset.type}; charset=utf-8`,
          'Content-Length': asset.body.length,
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        });
        return res.end(req.method === 'HEAD' ? undefined : asset.body);
      }
      if (['/api', '/health/live', '/health/ready', '/metrics'].includes(path)) {
        route = path;
        allow(['GET']);
        if (path === '/api') return json(200, { service: 'products-service', version: '1.0.0', products: '/products' });
        if (path === '/health/live') return json(200, { status: 'ok' });
        if (path === '/health/ready') {
          if (draining) return json(503, { status: 'unavailable' });
          try { store.ready(); } catch { return json(503, { status: 'unavailable' }); }
          return json(200, { status: 'ready' });
        }
        const metrics = [
          '# HELP products_http_requests_total Completed HTTP requests.',
          '# TYPE products_http_requests_total counter',
          ...Array.from(counts, ([labels, count]) => `products_http_requests_total{${labels}} ${count}`),
          '# HELP products_process_uptime_seconds Service process uptime in seconds.',
          '# TYPE products_process_uptime_seconds gauge',
          `products_process_uptime_seconds ${process.uptime()}`,
        ];
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
        return res.end(metrics.join('\n') + '\n');
      }
      if (draining) throw new HttpError(503, 'Service is shutting down');
      if (path === '/products') {
        route = '/products';
        allow(['GET', 'POST']);
        if (req.method === 'GET') {
          const search = (url.searchParams.get('search') ?? '').trim();
          if (search.length > 120) throw new HttpError(400, 'search must be at most 120 characters');
          const sort = url.searchParams.get('sort') ?? 'oldest';
          if (!['oldest', 'newest', 'name', 'price-asc', 'price-desc'].includes(sort)) throw new HttpError(400, 'Invalid sort order');
          return json(200, store.list(queryInteger(url, 'limit', 20, 1, 100), queryInteger(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER), search, sort));
        }
        const product = store.create(await readProduct(req));
        res.setHeader('Location', `/products/${product.id}`);
        return json(201, product);
      }
      const match = /^\/products\/([^/]+)$/.exec(path);
      if (match) {
        route = '/products/:id';
        allow(['GET', 'PUT', 'DELETE']);
        const id = match[1];
        if (!UUID.test(id)) throw new HttpError(400, 'Product id must be a UUID v4');
        let product;
        if (req.method === 'GET') product = store.get(id);
        if (req.method === 'PUT') product = store.update(id, await readProduct(req));
        if (req.method === 'DELETE') {
          if (!store.delete(id)) throw new HttpError(404, 'Product not found');
          return json(204);
        }
        if (!product) throw new HttpError(404, 'Product not found');
        return json(200, product);
      }
      throw new HttpError(404, 'Route not found');
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) logger({ level: 'error', requestId, message: error.message });
      if (status === 413) res.setHeader('Connection', 'close');
      json(status, { error: status === 500 ? 'Internal server error' : error.message, requestId });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return { server, drain() { draining = true; } };
}
