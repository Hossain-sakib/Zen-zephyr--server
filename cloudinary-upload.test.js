const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createUploadHandler } = require('./cloudinary-upload');

const env = {
  FIREBASE_WEB_API_KEY: 'test-project-key',
  CLOUDINARY_URL: 'cloudinary://test-key:test-secret@test-cloud',
  CLOUDINARY_UPLOAD_PRESET: 'restricted-profiles',
};
function response() {
  return { code: 200, headers: {}, status(code) { this.code = code; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { this.body = body; return this; } };
}
test('rejects anonymous requests without contacting Firebase', async () => {
  const res = response();
  await createUploadHandler({ env, fetchImpl: () => assert.fail('Unexpected request') })({ headers: {} }, res);
  assert.equal(res.code, 401);
});
test('does not sign uploads for invalid Firebase tokens', async () => {
  const res = response();
  await createUploadHandler({ env, fetchImpl: async () => ({ ok: false, status: 400 }) })({ headers: { authorization: 'Bearer invalid' } }, res);
  assert.equal(res.code, 401);
  assert.equal(res.body.signature, undefined);
});
test('signs only server-controlled parameters after Firebase verifies identity', async () => {
  const res = response();
  await createUploadHandler({ env, fetchImpl: async (url, options) => {
    assert.ok(url.startsWith('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='));
    assert.deepEqual(JSON.parse(options.body), { idToken: 'verified-token' });
    return { ok: true, json: async () => ({ users: [{ localId: 'user-123' }] }) };
  } })({ headers: { authorization: 'Bearer verified-token' }, body: { folder: 'attacker-folder', overwrite: true } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.params.folder, 'zen-zephyr/profiles/user-123');
  assert.equal(res.body.params.overwrite, false);
  assert.equal(res.body.params.upload_preset, 'restricted-profiles');
  const serialized = `folder=zen-zephyr/profiles/user-123&overwrite=false&timestamp=${res.body.params.timestamp}&upload_preset=restricted-profiles`;
  assert.equal(res.body.signature, createHash('sha1').update(serialized + 'test-secret').digest('hex'));
  assert.ok(!JSON.stringify(res.body).includes('test-secret'));
});
test('missing settings and network failures return safe errors', async () => {
  for (const options of [{ env: {} }, { env, fetchImpl: async () => { throw new Error('private upstream details'); } }]) {
    const res = response();
    await createUploadHandler(options)({ headers: { authorization: 'Bearer token' } }, res);
    assert.equal(res.code, 503);
    assert.ok(!JSON.stringify(res.body).includes('private upstream details'));
  }
});
