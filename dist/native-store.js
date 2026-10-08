"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readNativeDocument = readNativeDocument;
const node_fs_1 = require("node:fs");
const pg_1 = require("pg");
let pool;
async function readNativeDocument(collection, id) {
    if (!id || id.includes('/'))
        throw new Error('Invalid native document id');
    if (!pool) {
        const file = process.env.AGORA_NATIVE_CONNECTION_FILE;
        if (!file)
            throw new Error('Native VPS connection is required; Firestore fallback disabled');
        const configuration = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf8'));
        pool = new pg_1.Pool({ connectionString: configuration.url, max: 2, connectionTimeoutMillis: 10000,
            ssl: { ca: configuration.ca, rejectUnauthorized: true, servername: 'agora-store.elenxos.com' },
            application_name: 'agora-hub-native-readonly' });
        pool.on('error', () => console.error('[native-store] idle connection failed'));
    }
    const result = await pool.query('SELECT data FROM agora_native.documents WHERE path=$1', [`${collection}/${id}`]);
    return { exists: result.rows.length === 1, data: () => result.rows[0]?.data };
}
