const { test } = require('node:test');
const assert = require('node:assert/strict');
const serverless = require('serverless-http');
const { ObjectId } = require('mongodb');
const { createApp } = require('./index');
const { pairId } = require('./community');
const id = '507f1f77bcf86cd799439011';
const alice = { uid: 'alice', email: 'alice@example.test', name: 'Alice', picture: '' };
const bob = { uid: 'bob', email: 'bob@example.test', name: 'Bob', picture: '' };
function setup({ visibility = 'public', relation = null, role = 'user' } = {}) {
  const writes = []; const reads = [];
  const post = { _id: new ObjectId(id), authorUid: 'alice', authorEmail: alice.email, authorName: 'Alice',
    description: 'A community conversation', tag: 'Design', visibility, upVotes: [alice.email], createdAt: new Date().toISOString() };
  const collection = name => ({
    async findOne(query) { reads.push([name, query]); if (name === 'posts') return post; if (name === 'friendships') return relation;
      if (name === 'users') { const person = query.uid === 'bob' || query.email === bob.email ? bob : alice; return { ...person, name: person.name, role }; } return null; },
    async updateOne(query, update, options) { writes.push({ name, query, update, options }); return { matchedCount: 1, modifiedCount: 1, upsertedCount: 1 }; },
    async insertOne(doc) { writes.push({ name, doc }); return { insertedId: new ObjectId(id) }; },
    async findOneAndUpdate(query, update) { writes.push({ name, query, update }); return relation && relation.recipientUid === query.recipientUid && relation.status === query.status ? { ...relation, status: 'accepted' } : null; },
    async deleteOne(query) { writes.push({ name, query }); return { deletedCount: 1 }; },
    async deleteMany(query) { writes.push({ name, query }); return { deletedCount: 1 }; },
    async updateMany(query, update) { writes.push({ name, query, update }); return { modifiedCount: 1 }; },
    async countDocuments(query) { reads.push([name, query]); return 0; },
    find(query) { reads.push([name, query]); return { sort() { return this; }, limit() { return this; }, async toArray() { return []; } }; },
  });
  const db = Object.fromEntries(['users', 'posts', 'comments', 'friendships', 'notifications', 'saved', 'reports', 'blocks'].map(name => [name, collection(name)]));
  const authenticate = (req, res, next) => {
    const identity = req.headers.authorization === 'Bearer alice' ? alice : req.headers.authorization === 'Bearer bob' ? bob : null;
    if (!identity) return res.status(401).json({ message: 'Sign in required' });
    req.decoded = identity; next();
  };
  const handler = serverless(createApp({ getCollections: async () => db, authenticate }));
  return { writes, reads, async request(path, method = 'GET', body, user) {
    const result = await handler({ path: '/community' + path, httpMethod: method, headers: { 'content-type': 'application/json', ...(user ? { authorization: 'Bearer ' + user } : {}) },
      body: body ? JSON.stringify(body) : null, queryStringParameters: {}, isBase64Encoded: false }, {});
    return { status: result.statusCode, data: JSON.parse(result.body) };
  } };
}
test('public post DTO never exposes email addresses or raw voter identities', async () => {
  const f = setup(); const result = await f.request('/posts/' + id);
  assert.equal(result.status, 200); assert.equal(result.data.likes, 1);
  assert.equal(result.data.canEdit, false); assert.ok(!JSON.stringify(result.data).includes('@example.test'));
});
test('private post is unavailable to guests and unrelated members', async () => {
  const f = setup({ visibility: 'friends' });
  assert.equal((await f.request('/posts/' + id)).status, 404);
  assert.equal((await f.request('/posts/' + id, 'GET', null, 'bob')).status, 404);
  assert.equal((await f.request('/posts/' + id + '/comments', 'GET', null, 'bob')).status, 404);
});
test('author and accepted connection may read a friends-only conversation', async () => {
  const f = setup({ visibility: 'friends', relation: { status: 'accepted' } });
  assert.equal((await f.request('/posts/' + id, 'GET', null, 'alice')).status, 200);
  assert.equal((await f.request('/posts/' + id, 'GET', null, 'bob')).status, 200);
});
test('new posts require authentication and server-controlled ownership', async () => {
  const f = setup(); const body = { content: 'A fresh idea', topic: 'Design', visibility: 'public', authorUid: 'bob', authorEmail: bob.email, upVotes: ['forged'] };
  assert.equal((await f.request('/posts', 'POST', body)).status, 401);
  assert.equal((await f.request('/posts', 'POST', body, 'alice')).status, 201);
  const record = f.writes.find(item => item.name === 'posts').doc;
  assert.equal(record.authorUid, 'alice'); assert.equal(record.authorEmail, alice.email); assert.deepEqual(record.upVotes, []);
});
test('post validation rejects empty text, invalid audiences and unsafe image URLs', async () => {
  const f = setup();
  for (const body of [{ content: '', topic: 'Design', visibility: 'public' }, { content: 'Hi', topic: 'Design', visibility: 'admin' }, { content: 'Hi', topic: 'Design', visibility: 'public', image: 'javascript:alert(1)' }, { content: 'Hi', topic: 'Design', visibility: 'public', image: 'https://example.com/external.png' }]) {
    assert.equal((await f.request('/posts', 'POST', body, 'alice')).status, 400);
  }
  assert.equal(f.writes.filter(item => item.name === 'posts').length, 0);
});
test('only authors may edit or delete community posts', async () => {
  const f = setup();
  assert.equal((await f.request('/posts/' + id, 'PATCH', { content: 'Changed' }, 'bob')).status, 403);
  assert.equal((await f.request('/posts/' + id, 'DELETE', null, 'bob')).status, 403);
  assert.equal((await f.request('/posts/' + id, 'PATCH', { content: 'Changed', authorUid: 'bob' }, 'alice')).status, 200);
  const update = f.writes.find(item => item.name === 'posts').update.$set;
  assert.equal(update.description, 'Changed'); assert.ok(!('authorUid' in update));
});
test('comment author is derived from the authenticated member', async () => {
  const f = setup();
  const result = await f.request('/posts/' + id + '/comments', 'POST', { content: 'A thoughtful reply', commenterUid: 'alice' }, 'bob');
  assert.equal(result.status, 201);
  assert.equal(f.writes.find(item => item.name === 'comments').doc.commenterUid, 'bob');
  const note = f.writes.find(item => item.name === 'notifications').doc;
  assert.equal(note.recipientUid, 'alice'); assert.equal(note.actorUid, 'bob');
});
test('appreciations are idempotent and cannot select a different actor', async () => {
  const f = setup();
  assert.equal((await f.request('/posts/' + id + '/like', 'PUT', { liked: true, uid: 'alice' }, 'bob')).status, 200);
  assert.deepEqual(f.writes.find(item => item.name === 'posts').update.$addToSet, { upVotes: bob.email });
});
test('saved posts are always scoped to the signed-in member', async () => {
  const f = setup();
  assert.equal((await f.request('/posts/' + id + '/save', 'PUT', { saved: true, uid: 'alice' }, 'bob')).status, 200);
  const saved = f.writes.find(item => item.name === 'saved');
  assert.equal(saved.query._id, pairId('bob', id)); assert.equal(saved.update.$setOnInsert.uid, 'bob');
});
test('a connection sender cannot accept their own request', async () => {
  const relation = { members: ['alice', 'bob'], senderUid: 'alice', recipientUid: 'bob', status: 'pending' };
  const f = setup({ relation });
  assert.equal((await f.request('/connections/bob', 'PATCH', {}, 'alice')).status, 409);
  assert.equal((await f.request('/connections/alice', 'PATCH', {}, 'bob')).status, 200);
});
test('notifications and mark-read changes cannot target another member', async () => {
  const f = setup();
  assert.equal((await f.request('/notifications', 'GET', null, 'bob')).status, 200);
  assert.deepEqual(f.reads.find(item => item[0] === 'notifications')[1], { recipientUid: 'bob' });
  assert.equal((await f.request('/notifications/read', 'PATCH', { uid: 'alice' }, 'bob')).status, 200);
  assert.equal(f.writes.find(item => item.name === 'notifications').query.recipientUid, 'bob');
});
test('profile edits cannot set privileged fields', async () => {
  const f = setup();
  assert.equal((await f.request('/me', 'PATCH', { name: 'New name', bio: '', location: '', role: 'admin' }, 'alice')).status, 200);
  const update = f.writes.filter(item => item.name === 'users').at(-1).update.$set;
  assert.equal(update.name, 'New name'); assert.ok(!('role' in update));
});
test('moderation routes reject ordinary members', async () => {
  const f = setup();
  assert.equal((await f.request('/moderation/reports', 'GET', null, 'alice')).status, 403);
  assert.equal((await f.request('/moderation/content/' + id, 'DELETE', null, 'alice')).status, 403);
});

test('authorized moderators may load the review queue', async () => {
  const f = setup({ role: 'admin' });
  const result = await f.request('/moderation/reports', 'GET', null, 'alice');
  assert.equal(result.status, 200); assert.deepEqual(result.data, []);
});
