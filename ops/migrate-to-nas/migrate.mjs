#!/usr/bin/env node
// Migración Firebase → NAS:
//   - Lee el backup verificado en SOURCE (el dump que produjo ops/firebase-backup/backup.mjs).
//   - Sube a MinIO (bucket agora-blobs) cualquier blob de `documents.content` que aún
//     no exista bajo su storage_path canónico.
//   - Escribe la metadata de todas las colecciones a Postgres en el schema agora.
//   - Idempotente: re-correrlo no duplica.
//
// Convención de path canónico:
//   isPersonal(workspaceId) ?  users/<ownerId>/<folder>/<safeName>
//                          :  workspaces/<workspaceId>/<folder>/<safeName>
// Markdown: nombre forzado a `.md`. Otros tipos: extensión preservada.
//
// Variables requeridas:
//   SOURCE                  ruta al directorio del backup
//   PG_URL                  postgres://agora_app:PASS@host:5433/agora
//   S3_ENDPOINT             http://100.98.67.189:9000
//   S3_BUCKET               agora-blobs
//   S3_ACCESS_KEY           svc account de minio
//   S3_SECRET_KEY           secret del svc account
//   RUN_ID                  id de la corrida (default: timestamp)

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import pg from 'pg';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';

const { Pool } = pg;

const SOURCE = process.env.SOURCE || throwReq('SOURCE');
const PG_URL = process.env.PG_URL || throwReq('PG_URL');
const S3_ENDPOINT = process.env.S3_ENDPOINT || throwReq('S3_ENDPOINT');
const S3_BUCKET = process.env.S3_BUCKET || 'agora-blobs';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || throwReq('S3_ACCESS_KEY');
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || throwReq('S3_SECRET_KEY');
const RUN_ID = process.env.RUN_ID || `migrate-${new Date().toISOString().replace(/[:.]/g, '-')}`;

function throwReq(k) { throw new Error(`${k} is required`); }
const log = (...a) => console.log(new Date().toISOString(), ...a);

const NON_MD_TEXT_EXTS = new Set([
  '.st', '.json', '.xml', '.yaml', '.yml', '.toml', '.csv',
  '.html', '.css', '.scss', '.less', '.ini', '.log', '.txt',
]);

const sanitize = (v) => (v || 'Sin titulo').replace(/[\\/]/g, '_');

function ensureTextFileName(value) {
  const safe = sanitize(value);
  const lower = safe.toLowerCase();
  if (lower.endsWith('.md')) return safe;
  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && NON_MD_TEXT_EXTS.has(lower.slice(dot))) return safe;
  return `${safe}.md`;
}

function isPersonalWorkspaceId(wsId) {
  if (!wsId) return false;
  return wsId === 'personal' || wsId.startsWith('personal:');
}

function normalizeFolderPath(folder) {
  const f = (folder || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return f || '_root';
}

function buildStoragePath({ workspaceId, ownerId, folder, fileName }) {
  const prefix = isPersonalWorkspaceId(workspaceId) ? `users/${ownerId}` : `workspaces/${workspaceId}`;
  return `${prefix}/${normalizeFolderPath(folder)}/${fileName}`;
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function tsOrNull(v) {
  if (!v) return null;
  if (typeof v === 'string') return new Date(v).toISOString();
  if (v._seconds !== undefined) return new Date(v._seconds * 1000 + (v._nanoseconds || 0) / 1e6).toISOString();
  if (v.seconds !== undefined) return new Date(v.seconds * 1000).toISOString();
  return null;
}

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true,
});
const pool = new Pool({ connectionString: PG_URL, max: 4 });

async function exists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    return true;
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

async function* iterJsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    yield JSON.parse(line);
  }
}

async function exec(sql, params = []) {
  const res = await pool.query(sql, params);
  return res;
}

const stats = {
  workspaces: 0, users: 0, documents: 0, blobsUploaded: 0, blobsSkipped: 0,
  snippets: 0, boards: 0, agentAuditLog: 0, workspaceSemanticStates: 0,
  subscriptions: 0, errors: [],
};

await exec(`INSERT INTO agora.migration_runs(id, source, notes)
            VALUES ($1, $2, $3)
            ON CONFLICT (id) DO NOTHING`,
           [RUN_ID, SOURCE, 'firebase backup -> nas']);

// -------- WORKSPACES --------
log('migrating workspaces...');
const wsFile = path.join(SOURCE, 'firestore/workspaces.jsonl');
if (fs.existsSync(wsFile)) {
  for await (const r of iterJsonl(wsFile)) {
    const d = r.data || {};
    await exec(
      `INSERT INTO agora.workspaces(id,name,owner_id,is_personal,members,data,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, owner_id=EXCLUDED.owner_id, is_personal=EXCLUDED.is_personal,
         members=EXCLUDED.members, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [r.id, d.name || null, d.ownerId || null, isPersonalWorkspaceId(r.id),
       JSON.stringify(d.members || []), JSON.stringify(d),
       tsOrNull(r.createTime), tsOrNull(r.updateTime)]
    );
    stats.workspaces++;
  }
}
log(`  workspaces: ${stats.workspaces}`);

// -------- USERS --------
log('migrating users...');
const usersFile = path.join(SOURCE, 'firestore/users.jsonl');
if (fs.existsSync(usersFile)) {
  for await (const r of iterJsonl(usersFile)) {
    const d = r.data || {};
    await exec(
      `INSERT INTO agora.users(uid,email,display_name,plan_id,subscription,data,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)
       ON CONFLICT (uid) DO UPDATE SET
         email=EXCLUDED.email, display_name=EXCLUDED.display_name, plan_id=EXCLUDED.plan_id,
         subscription=EXCLUDED.subscription, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [r.id, d.email || null, d.displayName || null, d.planId || null,
       JSON.stringify(d.subscription || null), JSON.stringify(d),
       tsOrNull(r.createTime), tsOrNull(r.updateTime)]
    );
    stats.users++;
  }
}
log(`  users: ${stats.users}`);

// -------- DOCUMENTS (con migración de content -> minio) --------
log('migrating documents (with content -> minio)...');
const docsFile = path.join(SOURCE, 'firestore/documents.jsonl');
if (fs.existsSync(docsFile)) {
  for await (const r of iterJsonl(docsFile)) {
    const d = r.data || {};
    let storagePath = d.storagePath || null;
    let contentHash = null;
    let size = d.size || null;

    // Si el doc tiene content, lo subimos como blob al MinIO bajo el path canónico.
    if (typeof d.content === 'string' && d.content.length > 0) {
      const ownerId = d.ownerId;
      const workspaceId = d.workspaceId;
      const isText = !d.type || d.type === 'document' || d.type === 'text' || d.type === 'markdown';
      const fileName = isText ? ensureTextFileName(d.name) : sanitize(d.name);
      if (!storagePath) {
        storagePath = buildStoragePath({ workspaceId, ownerId, folder: d.folder, fileName });
      }
      const buf = Buffer.from(d.content, 'utf8');
      contentHash = sha256Hex(buf);
      size = buf.length;
      const already = await exists(storagePath);
      if (!already) {
        await s3.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: storagePath,
          Body: buf,
          ContentType: d.mimeType || 'text/markdown; charset=utf-8',
          Metadata: {
            'agora-version': '1',
            'agora-content-hash': contentHash,
            'agora-source': 'firestore-content',
          },
        }));
        stats.blobsUploaded++;
      } else {
        stats.blobsSkipped++;
      }
    } else if (storagePath) {
      // El blob ya estaba en Firebase Storage y ya fue migrado por mc mirror.
      // Computamos hash si tenemos el archivo local del backup.
      const localPath = path.join(SOURCE, 'storage', storagePath);
      try {
        const buf = await fsp.readFile(localPath);
        contentHash = sha256Hex(buf);
        if (size == null) size = buf.length;
      } catch { /* si no existe localmente, lo dejamos sin hash y ya */ }
    }

    await exec(
      `INSERT INTO agora.documents(
         id,name,type,workspace_id,owner_id,folder,mime_type,size,storage_path,
         storage_backend,content_hash,version,base_version,sync_state,last_writer,data,
         created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'minio',$10,1,1,'synced','migration',$11::jsonb,$12,$13)
       ON CONFLICT (id) DO UPDATE SET
         name=EXCLUDED.name, type=EXCLUDED.type, workspace_id=EXCLUDED.workspace_id,
         owner_id=EXCLUDED.owner_id, folder=EXCLUDED.folder, mime_type=EXCLUDED.mime_type,
         size=COALESCE(EXCLUDED.size, agora.documents.size),
         storage_path=COALESCE(EXCLUDED.storage_path, agora.documents.storage_path),
         storage_backend='minio',
         content_hash=COALESCE(EXCLUDED.content_hash, agora.documents.content_hash),
         data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [r.id, d.name || 'untitled', d.type || null, d.workspaceId || null,
       d.ownerId || null, d.folder || null, d.mimeType || null, size,
       storagePath, contentHash,
       JSON.stringify({ ...d, content: undefined }),
       tsOrNull(r.createTime), tsOrNull(r.updateTime)]
    );
    stats.documents++;
    if (stats.documents % 200 === 0) log(`  documents: ${stats.documents}`);
  }
}
log(`  documents: ${stats.documents} (blobs uploaded ${stats.blobsUploaded}, skipped ${stats.blobsSkipped})`);

// -------- SNIPPETS --------
log('migrating snippets...');
const snippetsFile = path.join(SOURCE, 'firestore/snippets.jsonl');
if (fs.existsSync(snippetsFile)) {
  for await (const r of iterJsonl(snippetsFile)) {
    const d = r.data || {};
    await exec(
      `INSERT INTO agora.snippets(id,workspace_id,owner_id,name,data,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         workspace_id=EXCLUDED.workspace_id, owner_id=EXCLUDED.owner_id,
         name=EXCLUDED.name, data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [r.id, d.workspaceId || null, d.ownerId || null, d.name || null,
       JSON.stringify(d), tsOrNull(r.createTime), tsOrNull(r.updateTime)]
    );
    stats.snippets++;
  }
}
log(`  snippets: ${stats.snippets}`);

// -------- BOARDS (root) --------
log('migrating boards (root)...');
const boardsFile = path.join(SOURCE, 'firestore/boards.jsonl');
if (fs.existsSync(boardsFile)) {
  for await (const r of iterJsonl(boardsFile)) {
    const d = r.data || {};
    // recoger cards/columns de subcolecciones si están dump'eadas
    const cardsFile = path.join(SOURCE, `firestore/boards/${r.id}/cards.jsonl`);
    const colsFile = path.join(SOURCE, `firestore/boards/${r.id}/columns.jsonl`);
    const cards = []; const columns = [];
    if (fs.existsSync(cardsFile)) for await (const c of iterJsonl(cardsFile)) cards.push({ id: c.id, ...(c.data || {}) });
    if (fs.existsSync(colsFile)) for await (const c of iterJsonl(colsFile)) columns.push({ id: c.id, ...(c.data || {}) });
    await exec(
      `INSERT INTO agora.boards(id,workspace_id,owner_id,data,cards,columns,created_at,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         workspace_id=EXCLUDED.workspace_id, owner_id=EXCLUDED.owner_id,
         data=EXCLUDED.data, cards=EXCLUDED.cards, columns=EXCLUDED.columns,
         updated_at=EXCLUDED.updated_at`,
      [r.id, d.workspaceId || null, d.ownerId || null,
       JSON.stringify(d), JSON.stringify(cards), JSON.stringify(columns),
       tsOrNull(r.createTime), tsOrNull(r.updateTime)]
    );
    stats.boards++;
  }
}
log(`  boards: ${stats.boards}`);

// -------- agentAuditLog --------
log('migrating agentAuditLog...');
const auditFile = path.join(SOURCE, 'firestore/agentAuditLog.jsonl');
if (fs.existsSync(auditFile)) {
  for await (const r of iterJsonl(auditFile)) {
    await exec(
      `INSERT INTO agora.agent_audit_log(id,data,created_at)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
      [r.id, JSON.stringify(r.data || {}), tsOrNull(r.createTime)]
    );
    stats.agentAuditLog++;
  }
}
log(`  agentAuditLog: ${stats.agentAuditLog}`);

// -------- workspaceSemanticStates --------
log('migrating workspaceSemanticStates...');
const wssFile = path.join(SOURCE, 'firestore/workspaceSemanticStates.jsonl');
if (fs.existsSync(wssFile)) {
  for await (const r of iterJsonl(wssFile)) {
    await exec(
      `INSERT INTO agora.workspace_semantic_states(workspace_id,data,updated_at)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (workspace_id) DO UPDATE SET data=EXCLUDED.data, updated_at=EXCLUDED.updated_at`,
      [r.id, JSON.stringify(r.data || {}), tsOrNull(r.updateTime)]
    );
    stats.workspaceSemanticStates++;
  }
}
log(`  workspaceSemanticStates: ${stats.workspaceSemanticStates}`);

// -------- subscriptions --------
log('migrating subscriptions...');
const subsFile = path.join(SOURCE, 'firestore/subscriptions.jsonl');
if (fs.existsSync(subsFile)) {
  for await (const r of iterJsonl(subsFile)) {
    const d = r.data || {};
    await exec(
      `INSERT INTO agora.subscriptions(id,user_id,data,status,created_at,updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         user_id=EXCLUDED.user_id, data=EXCLUDED.data, status=EXCLUDED.status,
         updated_at=EXCLUDED.updated_at`,
      [r.id, d.userId || null, JSON.stringify(d), d.status || null,
       tsOrNull(r.createTime), tsOrNull(r.updateTime)]
    );
    stats.subscriptions++;
  }
}
log(`  subscriptions: ${stats.subscriptions}`);

// -------- finish --------
await exec(`UPDATE agora.migration_runs SET finished_at=NOW(), stats=$2::jsonb
            WHERE id=$1`, [RUN_ID, JSON.stringify(stats)]);
log('DONE', stats);
await pool.end();
