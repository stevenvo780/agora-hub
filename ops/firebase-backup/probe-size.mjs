// Quick non-destructive probe: list firestore root collections, count docs in each,
// list storage objects, sum bytes. No data is written.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import fs from 'node:fs';

const SA = JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
initializeApp({
  credential: cert(SA),
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

const db = getFirestore();
const bucket = getStorage().bucket(process.env.FIREBASE_STORAGE_BUCKET);
const auth = getAuth();

console.log('=== FIRESTORE ===');
const roots = await db.listCollections();
let totalDocs = 0;
for (const c of roots) {
  const snap = await c.count().get();
  const n = snap.data().count;
  totalDocs += n;
  console.log(`  /${c.id}: ${n} docs`);
}
console.log(`  TOTAL_ROOT_DOCS: ${totalDocs}`);

console.log('=== STORAGE ===');
let totalBytes = 0, totalObjects = 0, pageToken;
do {
  const [files, , api] = await bucket.getFiles({ pageToken, autoPaginate: false, maxResults: 1000 });
  pageToken = api?.nextPageToken;
  for (const f of files) {
    totalObjects++;
    totalBytes += parseInt(f.metadata.size || '0', 10);
  }
  process.stdout.write(`  scanned ${totalObjects}\r`);
} while (pageToken);
console.log(`\n  TOTAL_OBJECTS: ${totalObjects}`);
console.log(`  TOTAL_BYTES: ${totalBytes} (${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GiB)`);

console.log('=== AUTH ===');
let userCount = 0, npt;
do {
  const r = await auth.listUsers(1000, npt);
  userCount += r.users.length;
  npt = r.pageToken;
} while (npt);
console.log(`  TOTAL_USERS: ${userCount}`);
