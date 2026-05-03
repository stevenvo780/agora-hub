#!/usr/bin/env node
/**
 * Vacía Firebase Storage bucket completo. Hace:
 *   1) Listing final con manifest sha256 (auditoría),
 *   2) Confirmación implícita por env CONFIRM_WIPE=YES,
 *   3) Bulk delete en batches de 500 (Storage Admin API permite delete batch).
 *
 * Pre-requisito: el contenido ya debe estar respaldado en NAS y verificado.
 *
 * Variables:
 *   GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_PROJECT_ID, FIREBASE_STORAGE_BUCKET
 *   CONFIRM_WIPE=YES   (sin esto, sólo lista, NO borra)
 *   DRY_RUN=1          (lista pero no borra; alias de !CONFIRM_WIPE)
 */
import { initializeApp, cert } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SA = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({ credential: cert(SA), projectId: process.env.FIREBASE_PROJECT_ID, storageBucket: process.env.FIREBASE_STORAGE_BUCKET });

const bucket = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
const confirm = process.env.CONFIRM_WIPE === 'YES' && !process.env.DRY_RUN;
const log = (...a) => console.log(new Date().toISOString(), ...a);

log('bucket:', bucket.name);
log('mode:', confirm ? 'WIPE' : 'DRY-RUN (set CONFIRM_WIPE=YES para borrar)');

let totalListed = 0;
let totalBytes = 0;
const manifest = [];
let pageToken;
do {
    const [files, , api] = await bucket.getFiles({ pageToken, autoPaginate: false, maxResults: 1000 });
    pageToken = api?.nextPageToken;
    for (const f of files) {
        totalListed++;
        const sz = parseInt(f.metadata.size || '0', 10);
        totalBytes += sz;
        manifest.push({ name: f.name, size: sz, md5: f.metadata.md5Hash, updated: f.metadata.updated });
    }
    if (totalListed % 500 === 0) log('listed', totalListed);
} while (pageToken);

const manifestStr = JSON.stringify({ bucket: bucket.name, totalListed, totalBytes, ts: new Date().toISOString(), files: manifest }, null, 2);
const sha = crypto.createHash('sha256').update(manifestStr).digest('hex');
const out = `/tmp/firebase-storage-final-listing-${Date.now()}.json`;
fs.writeFileSync(out, manifestStr);
log('listing saved:', out);
log('total objects:', totalListed, 'bytes:', totalBytes, '(' + (totalBytes / 1024 / 1024).toFixed(1) + ' MiB)');
log('manifest sha256:', sha);

if (!confirm) {
    log('DRY-RUN: no se borra nada. Ejecuta CONFIRM_WIPE=YES para proceder.');
    process.exit(0);
}

log('WIPE: borrando todos los objetos del bucket...');
let deleted = 0;
let failed = 0;
const BATCH = 100;
for (let i = 0; i < manifest.length; i += BATCH) {
    const slice = manifest.slice(i, i + BATCH);
    await Promise.all(slice.map(async (entry) => {
        try {
            await bucket.file(entry.name).delete({ ignoreNotFound: true });
            deleted++;
        } catch (e) {
            failed++;
            console.warn('FAIL', entry.name, e.message);
        }
    }));
    if (deleted % 500 === 0 || deleted + failed === manifest.length) {
        log('deleted', deleted, '/', manifest.length, 'failed', failed);
    }
}
log('DONE. deleted=', deleted, 'failed=', failed);
process.exit(failed > 0 ? 2 : 0);
