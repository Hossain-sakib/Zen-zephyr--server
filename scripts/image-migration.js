const { createHash } = require('node:crypto');
const { ObjectId } = require('mongodb');
const knownImages = require('./site-image-map.json');
const cache = new Map(Object.entries(knownImages));
const fields = ['userImage', 'authorImage', 'imageUrl', 'commenterImage', 'image', 'photoURL'];
async function copyImage(source, env = process.env) {
  const cloud = new URL(env.CLOUDINARY_URL);
  if (source.startsWith(`https://res.cloudinary.com/${cloud.hostname}/`)) return { url: source, existing: true };
  if (cache.has(source)) return { url: cache.get(source), existing: true };
  const params = { overwrite: false, public_id: 'zen-zephyr/community-assets/' + createHash('sha256').update(source).digest('hex').slice(0, 24), timestamp: Math.floor(Date.now() / 1000) };
  const canonical = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  const body = new FormData();
  Object.entries(params).forEach(([key, value]) => body.append(key, String(value)));
  body.append('file', source);
  body.append('api_key', decodeURIComponent(cloud.username));
  body.append('signature', createHash('sha1').update(canonical + decodeURIComponent(cloud.password)).digest('hex'));
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloud.hostname}/image/upload`, { method: 'POST', body, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error('Source image could not be copied');
  const result = await response.json();
  if (!result.secure_url?.startsWith(`https://res.cloudinary.com/${cloud.hostname}/`)) throw new Error('Invalid upload result');
  cache.set(source, result.secure_url);
  return { url: result.secure_url, existing: false };
}
async function migrateBatch(db, collection, after) {
  if (!['users', 'posts', 'comments', 'announcements'].includes(collection)) throw new Error('Invalid collection');
  if (after && !/^[a-f\d]{24}$/i.test(after)) throw new Error('Invalid cursor');
  const docs = await db[collection].find(after ? { _id: { $gt: new ObjectId(after) } } : {}).sort({ _id: 1 }).limit(5).toArray();
  const result = { scanned: docs.length, uploaded: 0, reused: 0, updated: 0, failed: 0, next: docs.length === 5 ? String(docs[4]._id) : null };
  for (const doc of docs) for (const field of fields) {
    const source = doc[field];
    if (typeof source !== 'string' || !/^https?:\/\//.test(source)) continue;
    try {
      const copied = await copyImage(source);
      if (copied.url === source) continue;
      if (copied.existing) result.reused++; else result.uploaded++;
      const key = createHash('sha256').update(`${collection}:${doc._id}:${field}:${source}`).digest('hex');
      // Keep originals for recovery and never overwrite a concurrently changed URL.
      await db.migrationLogs.updateOne({ _id: key }, { $setOnInsert: { collection, documentId: doc._id, field, original: source, replacement: copied.url, migratedAt: new Date().toISOString() } }, { upsert: true });
      const update = await db[collection].updateOne({ _id: doc._id, [field]: source }, { $set: { [field]: copied.url } });
      result.updated += update.modifiedCount;
    } catch { result.failed++; }
  }
  return result;
}
module.exports = { copyImage, migrateBatch };
