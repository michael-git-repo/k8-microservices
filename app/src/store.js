import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = 'id, name, description, price_cents AS priceCents, created_at AS createdAt, updated_at AS updatedAt';
  const get = db.prepare(`SELECT ${columns} FROM products WHERE id = ?`);
  return {
    list(limit, offset) {
      return {
        items: db.prepare(`SELECT ${columns} FROM products ORDER BY created_at, id LIMIT ? OFFSET ?`).all(limit, offset),
        total: db.prepare('SELECT count(*) AS total FROM products').get().total,
        limit,
        offset,
      };
    },
    get(id) { return get.get(id); },
    create(product) {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, product.name, product.description, product.priceCents, now, now);
      return get.get(id);
    },
    update(id, product) {
      const result = db.prepare('UPDATE products SET name = ?, description = ?, price_cents = ?, updated_at = ? WHERE id = ?')
        .run(product.name, product.description, product.priceCents, new Date().toISOString(), id);
      return result.changes ? get.get(id) : undefined;
    },
    delete(id) { return db.prepare('DELETE FROM products WHERE id = ?').run(id).changes > 0; },
    ready() { db.prepare('SELECT 1').get(); },
    close() { db.close(); },
  };
}
