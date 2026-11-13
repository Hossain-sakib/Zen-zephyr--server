const { test } = require('node:test');
const assert = require('node:assert/strict');
const serverless = require('serverless-http');
const { createApp } = require('./index');
const { createFirebaseAuth } = require('./auth');
const identity = { uid: 'alice', email: 'alice@example.test', name: 'Alice', picture: '' };
const id = '507f1f77bcf86cd799439011';
function fixture({ anonymous = false, post, existingUser } = {}) {
  const writes = [];
  const db = {
    users: { findOne: async () => existingUser || null, insertOne: async doc => { writes.push(doc); return { insertedId: id }; }, updateOne: async (filter, update) => { writes.push(update.$setOnInsert); return { upsertedId: id }; } },
    posts: { findOne: async () => post || null, deleteOne: async () => { writes.push('delete'); return { deletedCount: 1 }; },
      updateOne: async (filter, update) => { writes.push(update); return { matchedCount: 1 }; } },
  };
  const authenticate = anonymous ? createFirebaseAuth({ env: {} }) : (req, res, next) => { req.decoded = identity; next(); };
  const handler = serverless(createApp({ getCollections: async () => db, authenticate }));
  return { writes, request: async (path, method, body) => handler({ path, httpMethod: method,
    headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : null, isBase64Encoded: false }, {}) };
}
test('arbitrary email cannot mint a JWT without Firebase authentication', async () => {
  const f = fixture({ anonymous: true });
  assert.equal((await f.request('/jwt', 'POST', { email: 'admin@example.test' })).statusCode, 401);
});
test('Firebase token verification derives identity from Firebase, not caller body', async () => {
  const req = { headers: { authorization: 'Bearer id-token' }, body: { email: 'admin@example.test' } };
  const auth = createFirebaseAuth({ env: { FIREBASE_WEB_API_KEY: 'test' }, fetchImpl: async () => ({ ok: true,
    json: async () => ({ users: [{ localId: identity.uid, email: identity.email }] }) }) });
  let called = false;
  await auth(req, {}, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.decoded.email, identity.email);
});
test('user creation discards supplied role and identity', async () => {
  const f = fixture();
  const res = await f.request('/users', 'POST', { email: 'admin@example.test', uid: 'admin', role: 'admin', badge: 'gold', name: 'Alice' });
  assert.equal(res.statusCode, 201);
  assert.equal(f.writes[0].role, 'user');
  assert.equal(f.writes[0].badge, 'bronze');
  assert.equal(f.writes[0].email, identity.email);
});
test('one user cannot delete another user post', async () => {
  const f = fixture({ post: { authorUid: 'bob', authorEmail: 'bob@example.test' } });
  assert.equal((await f.request('/post/' + id, 'DELETE')).statusCode, 403);
  assert.deepEqual(f.writes, []);
});
test('owner can delete their post', async () => {
  const f = fixture({ post: { authorUid: 'alice' } });
  assert.equal((await f.request('/post/' + id, 'DELETE')).statusCode, 200);
  assert.deepEqual(f.writes, ['delete']);
});
test('arbitrary MongoDB updates and votes for another identity are rejected', async () => {
  const f = fixture({ post: { visibility: 'public' } });
  for (const body of [{ $set: { authorUid: 'alice' } }, { $push: { upVotes: 'bob@example.test' } }, { $pull: { title: identity.email } }]) {
    assert.equal((await f.request('/post/' + id, 'PATCH', body)).statusCode, 400);
  }
  assert.deepEqual(f.writes, []);
});
test('valid vote becomes atomic and idempotent with opposite vote removal', async () => {
  const f = fixture({ post: { visibility: 'public' } });
  assert.equal((await f.request('/post/' + id, 'PATCH', { $push: { upVotes: identity.email } })).statusCode, 200);
  assert.deepEqual(f.writes[0], { $addToSet: { upVotes: identity.email }, $pull: { downVotes: identity.email } });
});
test('non-admins cannot list users or promote users; private profiles are self-only', async () => {
  const f = fixture({ existingUser: { role: 'user' } });
  assert.equal((await f.request('/users', 'GET')).statusCode, 403);
  assert.equal((await f.request('/users/admin/' + id, 'PATCH')).statusCode, 403);
  assert.equal((await f.request('/users/bob@example.test', 'GET')).statusCode, 403);
});
test('malformed object IDs return 400 instead of crashing a function', async () => {
  const f = fixture();
  assert.equal((await f.request('/post/not-an-id', 'GET')).statusCode, 400);
});

test('legacy public post endpoint does not expose author or voter emails', async () => {
  const f = fixture({ post: { _id: id, authorEmail: 'private@example.test', upVotes: ['voter@example.test'], downVotes: [] } });
  const result = await f.request('/post/' + id, 'GET');
  assert.equal(result.statusCode, 200);
  assert.ok(!result.body.includes('@example.test'));
  assert.equal(JSON.parse(result.body).upVoteCount, 1);
});
