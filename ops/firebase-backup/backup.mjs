#!/usr/bin/env node
// Defensive full backup of Firebase project.
// - Firestore: all root collections + nested subcollections, JSONL per collection.
// - Storage: full mirror of bucket, preserving paths.
// - RTDB: single JSON dump of root.
// - Auth: all users in JSONL.
// Output layout under DEST:
//   firestore/<collection-path>.jsonl
//   storage/<original-path>
//   rtdb.json
//   auth/users.jsonl
//   manifest.json   (counts, bytes, sha256)
// Idempotent: skips storage objects whose local SHA-256 already matches.

import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getDatabase } from 'firebase-admin/database';
import { getAuth } from 'firebase-admin/auth';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const DEST = process.env.BACKUP_DEST;
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET;
const RTDB_URL = process.env.FIREBASE_DATABASE_URL;
const SA_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const RUN_ID = process.env.RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');

if (!DEST) throw new Error('BACKUP_DEST is required');
if (!PROJECT_ID) throw new Error('FIREBASE_PROJECT_ID is required');
if (!BUCKET) throw new Error('FIREBASE_STORAGE_BUCKET is required');

const credential = SA_PATH
  ? cert(JSON.parse(fs.readFileSync(SA_PATH, 'utf8')))
  : applicationDefault();

initializeApp({
  credential,
  projectId: PROJECT_ID,
  storageBucket: BUCKET,
  databaseURL: RTDB_URL,
});

const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);
const auth = getAuth();

const dest = path.resolve(DEST);
await fsp.mkdir(dest, { recursive: true });
await fsp.mkdir(path.join(dest, 'firestore'), { recursive: true });
await fsp.mkdir(path.join(dest, 'storage'), { recursive: true });
await fsp.mkdir(path.join(dest, 'auth'), { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);

const manifest = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  projectId: PROJECT_ID,
  bucket: BUCKET,
  rtdbUrl: RTDB_URL || null,
  firestore: { collections: {}, totalDocs: 0 },
  storage: { totalObjects: 0, totalBytes: 0, skipped: 0, downloaded: 0, failed: [] },
  rtdb: { bytes: 0, sha256: null, present: false },
  auth: { totalUsers: 0 },
  finishedAt: null,
};

async function sha256File(p) {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p), h);
  return h.digest('hex');
}

// ---------- FIRESTORE ----------
async function dumpCollection(colRef, prefix = '') {
  const colPath = prefix ? `${prefix}/${colRef.id}` : colRef.id;
  const safe = colPath.replace(/[^a-zA-Z0-9._/-]/g, '_');
  const out = path.join(dest, 'firestore', `${safe}.jsonl`);
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const stream = fs.createWriteStream(out);
  let count = 0;
  let snap;
  try {
    snap = await colRef.get();
  } catch (e) {
    log('  firestore: unable to read', colPath, e.message);
    stream.end();
    return;
  }
  for (const doc of snap.docs) {
    const record = {
      id: doc.id,
      path: doc.ref.path,
      data: doc.data(),
      createTime: doc.createTime?.toDate().toISOString() || null,
      updateTime: doc.updateTime?.toDate().toISOString() || null,
    };
    stream.write(JSON.stringify(record) + '\n');
    count++;
    // Recurse into subcollections of this doc
    try {
      const subs = await doc.ref.listCollections();
      for (const sub of subs) await dumpCollection(sub, doc.ref.path);
    } catch (e) {
      log('  firestore: cannot list subs of', doc.ref.path, e.message);
    }
  }
  await new Promise((r) => stream.end(r));
  manifest.firestore.collections[colPath] = count;
  manifest.firestore.totalDocs += count;
  log(`  firestore: ${colPath} → ${count} docs`);
}

log('FIRESTORE — listing root collections...');
const roots = await db.listCollections();
log(`  ${roots.length} root collection(s)`);
for (const c of roots) await dumpCollection(c);

// ---------- STORAGE ----------
log('STORAGE — listing all objects...');
const storageRoot = path.join(dest, 'storage');
let pageToken = undefined;
let totalListed = 0;
do {
  const [files, , apiResp] = await bucket.getFiles({
    pageToken,
    autoPaginate: false,
    maxResults: 1000,
  });
  pageToken = apiResp?.nextPageToken;
  for (const file of files) {
    totalListed++;
    const rel = file.name;
    const localPath = path.join(storageRoot, rel);
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    const remoteMd5b64 = file.metadata.md5Hash; // gcs MD5 base64
    const remoteSize = parseInt(file.metadata.size || '0', 10);

    let needsDownload = true;
    try {
      const st = await fsp.stat(localPath);
      if (st.size === remoteSize) {
        // verify md5 matches GCS-reported md5
        const md5 = crypto.createHash('md5');
        await pipeline(fs.createReadStream(localPath), md5);
        const localMd5b64 = md5.digest('base64');
        if (remoteMd5b64 && localMd5b64 === remoteMd5b64) {
          needsDownload = false;
          manifest.storage.skipped++;
        }
      }
    } catch {
      /* not present, will download */
    }

    if (needsDownload) {
      try {
        await file.download({ destination: localPath, validation: 'md5' });
        manifest.storage.downloaded++;
      } catch (e) {
        manifest.storage.failed.push({ name: rel, error: e.message });
        log(`  storage: FAILED ${rel} — ${e.message}`);
        continue;
      }
    }

    manifest.storage.totalObjects++;
    manifest.storage.totalBytes += remoteSize;
    if (manifest.storage.totalObjects % 100 === 0) {
      log(`  storage: processed ${manifest.storage.totalObjects} objects`);
    }
  }
} while (pageToken);
log(`  storage: total ${manifest.storage.totalObjects} objects, ${(manifest.storage.totalBytes / 1024 / 1024).toFixed(1)} MiB, ${manifest.storage.skipped} skipped, ${manifest.storage.downloaded} downloaded, ${manifest.storage.failed.length} failed`);

// ---------- RTDB ----------
if (RTDB_URL) {
  log('RTDB — fetching root...');
  try {
    const rtdb = getDatabase();
    const snap = await rtdb.ref('/').once('value');
    const json = JSON.stringify(snap.val(), null, 2);
    const out = path.join(dest, 'rtdb.json');
    await fsp.writeFile(out, json);
    manifest.rtdb.bytes = Buffer.byteLength(json);
    manifest.rtdb.sha256 = crypto.createHash('sha256').update(json).digest('hex');
    manifest.rtdb.present = true;
    log(`  rtdb: ${manifest.rtdb.bytes} bytes`);
  } catch (e) {
    log('  rtdb: FAILED —', e.message);
    manifest.rtdb.error = e.message;
  }
} else {
  log('RTDB — skipped (no FIREBASE_DATABASE_URL)');
}

// ---------- AUTH ----------
log('AUTH — listing all users...');
const authOut = path.join(dest, 'auth', 'users.jsonl');
const authStream = fs.createWriteStream(authOut);
let nextPageToken;
do {
  const res = await auth.listUsers(1000, nextPageToken);
  for (const u of res.users) {
    authStream.write(JSON.stringify(u.toJSON()) + '\n');
    manifest.auth.totalUsers++;
  }
  nextPageToken = res.pageToken;
} while (nextPageToken);
await new Promise((r) => authStream.end(r));
log(`  auth: ${manifest.auth.totalUsers} users`);

// ---------- MANIFEST ----------
manifest.finishedAt = new Date().toISOString();
const mPath = path.join(dest, 'manifest.json');
await fsp.writeFile(mPath, JSON.stringify(manifest, null, 2));

// hash everything in the backup tree (top-level summary)
log('Hashing artifacts (top-level)...');
const topLevel = ['rtdb.json', 'auth/users.jsonl'];
const hashes = {};
for (const rel of topLevel) {
  const p = path.join(dest, rel);
  try {
    hashes[rel] = await sha256File(p);
  } catch {}
}
hashes['manifest.json'] = await sha256File(mPath);
await fsp.writeFile(path.join(dest, 'sha256.txt'),
  Object.entries(hashes).map(([k, v]) => `${v}  ${k}`).join('\n') + '\n');

log('DONE — backup at', dest);
log('  totalDocs:', manifest.firestore.totalDocs);
log('  totalStorageObjects:', manifest.storage.totalObjects);
log('  totalUsers:', manifest.auth.totalUsers);
log('  storageBytes:', manifest.storage.totalBytes);
log('  failedStorage:', manifest.storage.failed.length);
process.exit(manifest.storage.failed.length > 0 ? 2 : 0);
