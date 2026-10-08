import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

let pool: Pool | undefined;
export async function readNativeDocument(collection: 'users' | 'workspaces', id: string) {
  if (!id || id.includes('/')) throw new Error('Invalid native document id');
  if (!pool) {
    const file = process.env.AGORA_NATIVE_CONNECTION_FILE;
    if (!file) throw new Error('Native VPS connection is required; Firestore fallback disabled');
    const configuration = JSON.parse(readFileSync(file, 'utf8')) as { url: string; ca: string };
    pool = new Pool({ connectionString: configuration.url, max: 2, connectionTimeoutMillis: 10000,
      ssl: { ca: configuration.ca, rejectUnauthorized: true, servername: 'agora-store.elenxos.com' },
      application_name: 'agora-hub-native-readonly' });
    pool.on('error', () => console.error('[native-store] idle connection failed'));
  }
  const result = await pool.query<{ data: Record<string, unknown> }>(
    'SELECT data FROM agora_native.documents WHERE path=$1', [`${collection}/${id}`]);
  return { exists: result.rows.length === 1, data: () => result.rows[0]?.data };
}
