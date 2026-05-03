#!/usr/bin/env node
/**
 * Limpia residuos de `documents.content` en Firestore después de la migración a MinIO.
 *
 * - Si un doc tiene `storagePath` pero todavía conserva `content` → borrar `content`
 *   (la verdad ya vive en MinIO).
 * - Si un doc NO tiene `storagePath` y SÍ tiene `content` → es un doc que nunca
 *   migró (folders, snippets viejos, docs vacíos). Lo dejamos intacto: no podemos
 *   migrarlo sin contexto, y borrarlo perdería datos.
 *
 * DRY_RUN=1 lista pero no borra. CONFIRM_CLEANUP=YES lo aplica.
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import fs from 'node:fs';

const SA = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ credential: cert(SA), projectId: process.env.FIREBASE_PROJECT_ID });
const db = getFirestore();

const confirm = process.env.CONFIRM_CLEANUP === 'YES' && !process.env.DRY_RUN;
const log = (...a) => console.log(new Date().toISOString(), ...a);

let scanned = 0, withContentAndPath = 0, withContentNoPath = 0, cleaned = 0;
const orphans = [];
const collection = db.collection('documents');
let last;
while (true) {
    let q = collection.orderBy('__name__').limit(200);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    last = snap.docs[snap.docs.length - 1];

    const batch = db.batch();
    let writes = 0;
    for (const d of snap.docs) {
        scanned++;
        const data = d.data();
        const hasContent = typeof data.content === 'string' && data.content.length > 0;
        if (!hasContent) continue;
        if (data.storagePath) {
            withContentAndPath++;
            if (confirm) {
                batch.update(d.ref, { content: FieldValue.delete() });
                writes++;
                cleaned++;
            }
        } else {
            withContentNoPath++;
            orphans.push({ id: d.id, name: data.name, type: data.type, contentLen: data.content.length });
        }
    }
    if (writes > 0) await batch.commit();
}

log('scanned:', scanned);
log('docs con content + storagePath (cleanable):', withContentAndPath);
log('docs con content sin storagePath (huérfanos, NO se tocan):', withContentNoPath);
if (confirm) log('cleaned (content removed):', cleaned);
else log('DRY-RUN: no se modificó nada');

if (orphans.length > 0) {
    const out = `/tmp/firestore-content-orphans-${Date.now()}.json`;
    fs.writeFileSync(out, JSON.stringify(orphans, null, 2));
    log('orphans dump:', out);
}
