#!/usr/bin/env node
// Stamp en Firestore: para cada doc con `storagePath`, marca `storageBackend='minio'`
// y BORRA el campo `content` (verdad ahora vive en MinIO).
// Idempotente: skip si ya está marcado.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fs from 'node:fs';

const SA = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ credential: cert(SA), projectId: process.env.FIREBASE_PROJECT_ID });
const db = getFirestore();

const log = (...a) => console.log(new Date().toISOString(), ...a);

let stamped = 0, skipped = 0, contentDropped = 0, scanned = 0;
const collection = db.collection('documents');

let last;
const limit = 200;
while (true) {
  let q = collection.orderBy('__name__').limit(limit);
  if (last) q = q.startAfter(last);
  const snap = await q.get();
  if (snap.empty) break;
  last = snap.docs[snap.docs.length - 1];

  const batch = db.batch();
  let writes = 0;
  for (const d of snap.docs) {
    scanned++;
    const data = d.data();
    const update = {};
    if (data.storagePath && data.storageBackend !== 'minio') {
      update.storageBackend = 'minio';
      stamped++;
    }
    if (typeof data.content === 'string' && data.content.length > 0 && data.storagePath) {
      update.content = FieldValue.delete();
      contentDropped++;
    }
    if (Object.keys(update).length === 0) {
      skipped++;
      continue;
    }
    batch.update(d.ref, update);
    writes++;
  }
  if (writes > 0) await batch.commit();
  if (scanned % 500 === 0) log(`scanned=${scanned} stamped=${stamped} contentDropped=${contentDropped} skipped=${skipped}`);
}
log(`DONE scanned=${scanned} stamped=${stamped} contentDropped=${contentDropped} skipped=${skipped}`);
