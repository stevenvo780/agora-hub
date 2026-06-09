"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hubGitCommit = exports.isGitCommitConfigured = void 0;
/**
 * Commit de workspace EN EL VPS (corre en agora-storage, junto a MinIO y
 * Forgejo locales). AgoraBack manda solo la LISTA de archivos (metadata, sin
 * contenido); el Hub lee los blobs de MinIO local + arma el commit y lo pushea
 * a Forgejo local. Así el body grande (decenas/cientos de MB base64) se bufferea
 * acá (8GB de RAM, sin límite de Cloud Run) y sin egress — todo es localhost.
 *
 * Reemplaza el path donde AgoraBack (256-512Mi) hacía OOM con commits grandes.
 */
const client_s3_1 = require("@aws-sdk/client-s3");
const S3_ENDPOINT = process.env.NAS_S3_ENDPOINT; // http://127.0.0.1:9000 (local)
const S3_KEY = process.env.NAS_S3_ACCESS_KEY;
const S3_SECRET = process.env.NAS_S3_SECRET_KEY;
const S3_BUCKET = process.env.NAS_S3_BUCKET || 'agora-blobs';
const S3_REGION = process.env.NAS_S3_REGION || 'us-east-1';
const FORGEJO_API = (process.env.FORGEJO_API_URL || '').replace(/\/$/, ''); // http://127.0.0.1:3000 (local)
const FORGEJO_TOKEN = process.env.FORGEJO_ADMIN_TOKEN;
const isGitCommitConfigured = () => Boolean(S3_ENDPOINT && S3_KEY && S3_SECRET && FORGEJO_API && FORGEJO_TOKEN);
exports.isGitCommitConfigured = isGitCommitConfigured;
let _s3 = null;
const s3 = () => {
    if (!_s3) {
        _s3 = new client_s3_1.S3Client({
            endpoint: S3_ENDPOINT,
            region: S3_REGION,
            credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
            forcePathStyle: true,
        });
    }
    return _s3;
};
const readBlob = async (key) => {
    const r = await s3().send(new client_s3_1.GetObjectCommand({ Bucket: S3_BUCKET, Key: key.replace(/^\//, '') }));
    const chunks = [];
    // @ts-expect-error Body es un stream en Node
    for await (const c of r.Body)
        chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
};
const isRetriable = (status) => status === 0 || status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
const forgejoPost = async (path, body, maxAttempts = 6) => {
    let lastStatus = 0;
    let lastRaw = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const res = await fetch(`${FORGEJO_API}${path}`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `token ${FORGEJO_TOKEN}` },
                body: JSON.stringify(body),
            });
            const raw = await res.text();
            if (res.status >= 400 && isRetriable(res.status) && attempt < maxAttempts) {
                lastStatus = res.status;
                lastRaw = raw;
                await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
                continue;
            }
            return { status: res.status, raw };
        }
        catch (e) {
            lastRaw = e.message;
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, 1500 * 2 ** (attempt - 1)));
                continue;
            }
        }
    }
    return { status: lastStatus, raw: lastRaw };
};
/**
 * Lee los blobs de MinIO local + commitea TODO en un único POST a Forgejo local
 * (all-or-nothing, igual que el path original de AgoraBack). El buffer del body
 * vive en la RAM del VPS (sin límite Cloud Run), y el push a Forgejo es local.
 */
const hubGitCommit = async (params) => {
    const branch = params.branch || 'main';
    const totalFiles = params.files.length;
    if (!(0, exports.isGitCommitConfigured)())
        return { ok: false, error: 'git-commit no configurado en el Hub', totalFiles };
    if (totalFiles === 0)
        return { ok: false, error: 'sin archivos', totalFiles };
    const built = [];
    for (const f of params.files) {
        if (f.operation === 'delete') {
            built.push({ path: f.repoPath, operation: 'delete', sha: f.sha });
            continue;
        }
        if (!f.storagePath)
            continue;
        const buf = await readBlob(f.storagePath);
        built.push({
            path: f.repoPath,
            operation: f.operation === 'update' ? 'update' : 'create',
            content: buf.toString('base64'),
            ...(f.operation === 'update' && f.sha ? { sha: f.sha } : {}),
        });
    }
    if (built.length === 0)
        return { ok: false, error: 'ningún archivo legible', totalFiles };
    const author = params.authorName
        ? { author: { name: params.authorName, email: params.authorEmail ?? `${params.authorName}@noreply.agora.local` } }
        : {};
    const r = await forgejoPost(`/api/v1/repos/${params.repoFullName}/contents`, {
        files: built, message: params.message, branch, ...author,
    });
    if (r.status >= 400 || r.status === 0) {
        return { ok: false, status: r.status, error: r.raw.slice(0, 300), totalFiles };
    }
    let sha;
    try {
        sha = JSON.parse(r.raw).commit?.sha;
    }
    catch { /* noop */ }
    return { ok: true, sha, status: r.status, totalFiles };
};
exports.hubGitCommit = hubGitCommit;
