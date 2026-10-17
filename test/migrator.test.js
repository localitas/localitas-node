const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Migrator } = require('../src/migrator');

const SEED = {
  '20260101-000000-000-tables.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);',
  '20260102-000000-000-seed.sql': "INSERT INTO items (name) VALUES ('default');",
  '20260103-000000-000-column.sql': 'ALTER TABLE items ADD COLUMN color TEXT;',
};

function writeMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

// A Migrator whose callables run on their own connection to a real SQLite file.
function sqliteMigrator(dir, dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  const migrator = new Migrator(
    dir,
    async (sql, ...args) => db.prepare(sql).run(...args),
    async (sql, ...args) => ({ rows: db.prepare(sql).all(...args).map((r) => Object.values(r)) }),
    async (stmts) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const s of stmts) db.prepare(s.sql).run(...s.args);
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      db.exec('COMMIT');
    },
  );
  return { migrator, db };
}

function column(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all().map((r) => Object.values(r)[0]);
  } finally {
    db.close();
  }
}

describe('Migrator', () => {
  let dbPath;
  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'app.sqlitedb');
  });

  it('applies every migration once', async () => {
    const { migrator } = sqliteMigrator(writeMigrations(SEED), dbPath);
    await migrator.run();
    await migrator.run();
    assert.deepStrictEqual(column(dbPath, 'SELECT name FROM items'), ['default']);
    assert.deepStrictEqual(column(dbPath, 'SELECT version FROM schema_migrations ORDER BY version'),
      ['20260101-000000-000', '20260102-000000-000', '20260103-000000-000']);
  });

  it('a stale instance does not reapply a migration another applied', async () => {
    const dir = writeMigrations(SEED);
    await sqliteMigrator(dir, dbPath).migrator.run();
    const stale = sqliteMigrator(dir, dbPath).migrator;
    for (const m of stale._migrations) {
      await assert.rejects(stale._apply(m), /UNIQUE constraint failed: schema_migrations.version/);
    }
    assert.deepStrictEqual(column(dbPath, 'SELECT name FROM items'), ['default']);
  });

  it('a failed migration changes nothing', async () => {
    const { migrator } = sqliteMigrator(writeMigrations({
      '20260101-000000-000-tables.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY);',
      '20260102-000000-000-two.sql': 'ALTER TABLE items ADD COLUMN a TEXT; INSERT INTO missing VALUES (1);',
    }), dbPath);
    await assert.rejects(migrator.run(), /no such table: missing/);
    assert.deepStrictEqual(column(dbPath, "SELECT name FROM pragma_table_info('items')"), ['id']);
    assert.deepStrictEqual(column(dbPath, 'SELECT version FROM schema_migrations'), ['20260101-000000-000']);
  });

  it('records a schema change already in place', async () => {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, color TEXT)');
    db.close();
    const { migrator } = sqliteMigrator(writeMigrations({
      '20260101-000000-000-tables.sql': 'CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT);',
      '20260103-000000-000-column.sql': 'ALTER TABLE items ADD COLUMN color TEXT;',
    }), dbPath);
    await migrator.run();
    assert.deepStrictEqual(column(dbPath, 'SELECT version FROM schema_migrations ORDER BY version'),
      ['20260101-000000-000', '20260103-000000-000']);
  });

  it('reports bad SQL', async () => {
    const { migrator } = sqliteMigrator(writeMigrations({
      '20260101-000000-000-bad.sql': 'CREATE TABLEX items (id INTEGER);',
    }), dbPath);
    await assert.rejects(migrator.run(), /syntax error/);
  });
});
