import { resolve } from 'node:path';
import { createStore } from './store.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
const store = createStore(process.env.DB_PATH ?? resolve('data/products.sqlite'));
const { server, drain } = createApp({ store });
server.on('error', error => {
  console.error(JSON.stringify({ level: 'error', message: error.message }));
  store.close();
  process.exitCode = 1;
});
server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
  console.log(JSON.stringify({ level: 'info', message: 'Products service listening', port }));
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  drain();
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(() => {
    clearTimeout(timeout);
    store.close();
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
