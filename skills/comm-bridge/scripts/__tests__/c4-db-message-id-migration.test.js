import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

import { makeTempDir } from '../../../../test/helpers/temp-dir.js';

const tmpDir = makeTempDir('c4-db-message-migration-');
const dataDir = path.join(tmpDir, 'comm-bridge');
fs.mkdirSync(dataDir, { recursive: true });

const initSqlPath = fileURLToPath(new URL('../../init-db.sql', import.meta.url));
const legacySql = fs.readFileSync(initSqlPath, 'utf8')
  .replace(/^\s*source_message_id TEXT,.*\n/m, '')
  .replace(/CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_channel_source_message\n\s+ON conversations\(channel, source_message_id\)\n\s+WHERE source_message_id IS NOT NULL;\n/m, '');

const legacyDb = new Database(path.join(dataDir, 'c4.db'));
legacyDb.exec(legacySql);
legacyDb.close();

const originalYosDir = process.env.YOS_DIR;
process.env.YOS_DIR = tmpDir;
const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const dbModule = await import(new URL(`../c4-db.js?${cacheBuster}`, import.meta.url));

after(() => {
  dbModule.close();
  if (originalYosDir === undefined) delete process.env.YOS_DIR;
  else process.env.YOS_DIR = originalYosDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('adds source-message deduplication to an existing conversations database', () => {
  const db = dbModule.getDb();
  const columns = db.prepare('PRAGMA table_info(conversations)').all().map((column) => column.name);
  const indexes = db.prepare('PRAGMA index_list(conversations)').all().map((index) => index.name);

  assert.ok(columns.includes('source_message_id'));
  assert.ok(indexes.includes('idx_conversations_channel_source_message'));
});
