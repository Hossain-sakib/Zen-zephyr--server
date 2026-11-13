require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { createFirebaseAuth } = require('./auth');
const { createUploadHandler } = require('./cloudinary-upload');
const { createCommunityRouter } = require('./community');
const { cloudImage, profileImage } = require('./media');
const { createSocialRouter } = require('./social');
const { isBlocked } = require('./safety');

let client;
let databaseReady;
async function connectDatabase() {
  if (!databaseReady) {
    databaseReady = (async () => {
      const uri = process.env.MONGODB_URI || (process.env.DB_USER && process.env.DB_PASS
        ? `mongodb+srv://${encodeURIComponent(process.env.DB_USER)}:${encodeURIComponent(process.env.DB_PASS)}@cluster0.y2vlbq8.mongodb.net/?retryWrites=true&w=majority` : null);
      if (!uri) throw new Error('Missing database configuration');
      if (!client) client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000,
        serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
      });
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      const db = client.db('zzDB');
      await Promise.all([
        db.collection('user').createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'community_unique_email' }),
        db.collection('user').createIndex({ uid: 1 }, { unique: true, partialFilterExpression: { uid: { $type: 'string' } }, name: 'community_unique_uid' }),
        db.collection('post').createIndex({ authorUid: 1, _id: -1 }),
        db.collection('comment').createIndex({ postId: 1, _id: 1 }),
        db.collection('friendship').createIndex({ members: 1, status: 1 }),
        db.collection('notification').createIndex({ recipientUid: 1, _id: -1 }),
        db.collection('saved').createIndex({ uid: 1, postId: 1 }),
        db.collection('space').createIndex({ type: 1, _id: -1 }),
        db.collection('space_membership').createIndex({ spaceId: 1, status: 1 }),
        db.collection('space_membership').createIndex({ uid: 1, status: 1 }),
        db.collection('space_post').createIndex({ spaceId: 1, _id: -1 }),
        db.collection('space_comment').createIndex({ postId: 1, _id: 1 }),
        db.collection('conversation').createIndex({ members: 1, updatedAt: -1 }),
        db.collection('message').createIndex({ conversationId: 1, _id: -1 }),
        db.collection('message').createIndex({ conversationId: 1, senderUid: 1, nonce: 1 }, { unique: true }),
        db.collection('conversation_read').createIndex({ uid: 1 }),
        db.collection('block').createIndex({ ownerUid: 1, targetUid: 1 }),
        db.collection('story').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('story_view').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('event').createIndex({ startsAt: 1 }),
        db.collection('event_rsvp').createIndex({ eventId: 1, status: 1 }),
        db.collection('listing').createIndex({ status: 1, _id: -1 }),
      ]);
      return { users: db.collection('user'), posts: db.collection('post'), comments: db.collection('comment'),
        announcements: db.collection('announcement'), reports: db.collection('report'),
        friendships: db.collection('friendship'), notifications: db.collection('notification'), saved: db.collection('saved'), migrationLogs: db.collection('asset_migration_log'),
        spaces: db.collection('space'), memberships: db.collection('space_membership'), spacePosts: db.collection('space_post'), spaceComments: db.collection('space_comment'),
        conversations: db.collection('conversation'), messages: db.collection('message'), conversationReads: db.collection('conversation_read'), blocks: db.collection('block'),
        stories: db.collection('story'), storyViews: db.collection('story_view'), events: db.collection('event'), rsvps: db.collection('event_rsvp'), listings: db.collection('listing') };
    })().catch(error => { databaseReady = undefined; throw error; });
  }
  return databaseReady;
}

function publicLegacyPost(post) {
  const { authorEmail, upVotes = [], downVotes = [], ...publicData } = post;
  return { ...publicData, upVoteCount: upVotes.length, downVoteCount: downVotes.length };
}
function createApp({ getCollections = connectDatabase, authenticate = createFirebaseAuth() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-store');
    next();
  });
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const database = wrap(async (req, res, next) => {
    try { req.db = await getCollections(); } catch (error) {
      console.error('Database connection unavailable', JSON.stringify({ name: error.name, code: error.code,
        servers: error.reason?.servers ? Array.from(error.reason.servers.values(), server => ({ name: server.error?.name, code: server.error?.code, causeCode: server.error?.cause?.code })) : undefined }));
      return res.status(503).json({ message: 'Database temporarily unavailable' });
    }
    next();
  });
  const admin = wrap(async (req, res, next) => {
    const user = await req.db.users.findOne({ email: req.decoded.email });
    if (user?.role !== 'admin') return res.status(403).json({ message: 'Admin access required' });
    next();
  });
  const ownEmail = (req, res, next) => req.params.email === req.decoded.email
    ? next() : res.status(403).json({ message: 'Access denied' });
  const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  const owns = (record, identity) => record.authorUid ? record.authorUid === identity.uid : record.authorEmail === identity.email;
  const cleanImage = cloudImage;
  const safeId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
  app.param('id', (req, res, next, id) => safeId(id) ? next() : res.status(400).json({ message: 'Invalid ID' }));
  app.param('postId', (req, res, next, id) => safeId(id) ? next() : res.status(400).json({ message: 'Invalid post ID' }));
  const secured = [authenticate, database];
  const privileged = [...secured, admin];

  app.use('/community', createCommunityRouter({ getCollections, authenticate }));
  app.use('/social', createSocialRouter({ getCollections, authenticate }));
  app.get('/', (req, res) => res.send('is running'));
  app.get('/health', database, (req, res) => res.json({ status: 'ready' }));
  app.post('/uploads/signature', createUploadHandler());
  // Old clients cannot mint a token for an arbitrary email anymore.
  app.post('/jwt', authenticate, (req, res) => res.status(410).json({ message: 'Use your Firebase ID token directly' }));

  app.post('/users', ...secured, wrap(async (req, res) => {
    const identity = req.decoded;
    const record = { uid: identity.uid, email: identity.email,
      name: text(req.body.name, 120) ? req.body.name.trim() : identity.name,
      userImage: cleanImage(req.body.userImage) || await profileImage(identity.picture), badge: 'bronze', role: 'user' };
    try {
      const result = await req.db.users.updateOne({ email: identity.email }, { $setOnInsert: record }, { upsert: true });
      res.status(result.upsertedId ? 201 : 200).json({ insertedId: result.upsertedId || null });
    } catch (error) {
      if (error.code === 11000) return res.json({ insertedId: null, message: 'User already exists' });
      throw error;
    }
  }));
  app.get('/users', ...privileged, wrap(async (req, res) => res.json(await req.db.users.find().limit(100).toArray())));
  app.get('/users/:email', ...secured, ownEmail, wrap(async (req, res) => res.json(await req.db.users.findOne({ email: req.decoded.email }))));
  app.patch('/users/admin/:id', ...privileged, wrap(async (req, res) => res.json(await req.db.users.updateOne(
    { _id: new ObjectId(req.params.id) }, { $set: { role: 'admin' } }))));
  app.get('/users/admin/:email', ...secured, ownEmail, wrap(async (req, res) => {
    const user = await req.db.users.findOne({ email: req.decoded.email });
    res.json({ admin: user?.role === 'admin' });
  }));

  app.get('/post', database, wrap(async (req, res) => res.json((await req.db.posts.find({ visibility: { $ne: 'friends' } }).sort({ createdAt: -1 }).limit(100).toArray()).map(publicLegacyPost))));
  app.post('/post', ...secured, wrap(async (req, res) => {
    if (!text(req.body.title, 300) || !text(req.body.description, 20000) || !text(req.body.tag, 100)) return res.status(400).json({ message: 'Valid title, description and tag required' });
    const profile = await req.db.users.findOne({ email: req.decoded.email });
    res.status(201).json(await req.db.posts.insertOne({ title: req.body.title.trim(), description: req.body.description.trim(), tag: req.body.tag.trim(),
      authorUid: req.decoded.uid, authorEmail: req.decoded.email, authorName: profile?.name || req.decoded.name,
      authorImage: profile?.userImage || req.decoded.picture, createdAt: new Date().toISOString(), upVotes: [], downVotes: [] }));
  }));
  app.get('/post/:id', database, wrap(async (req, res) => {
    const post = await req.db.posts.findOne({ _id: new ObjectId(req.params.id), visibility: { $ne: 'friends' } });
    res.status(post ? 200 : 404).json(post ? publicLegacyPost(post) : { message: 'Post not found' });
  }));
  app.patch('/post/:id', ...secured, wrap(async (req, res) => {
    // Retain the legacy voting UI, but permit only the authenticated actor's votes.
    const accessiblePost = await req.db.posts.findOne({ _id: new ObjectId(req.params.id), visibility: { $ne: 'friends' } });
    if (!accessiblePost) return res.status(404).json({ message: 'Post not found' });
    if (await isBlocked(req.db, req.decoded.uid, accessiblePost.authorUid)) return res.status(403).json({ message: 'Interaction unavailable' });
    const body = req.body;
    if (!body || !Object.keys(body).length || Object.keys(body).some(op => !['$push', '$pull'].includes(op)) ||
      Object.values(body).some(fields => !fields || Array.isArray(fields) || typeof fields !== 'object' || !Object.keys(fields).length ||
        Object.entries(fields).some(([field, value]) => !['upVotes', 'downVotes'].includes(field) || value !== req.decoded.email))) {
      return res.status(400).json({ message: 'Only your own vote may be changed' });
    }
    const pushFields = Object.keys(body.$push || {});
    if (pushFields.length > 1) return res.status(400).json({ message: 'Choose one vote' });
    let update;
    if (pushFields.length) {
      const field = pushFields[0];
      update = { $addToSet: { [field]: req.decoded.email }, $pull: { [field === 'upVotes' ? 'downVotes' : 'upVotes']: req.decoded.email } };
    } else { update = { $pull: body.$pull }; }
    const result = await req.db.posts.updateOne({ _id: new ObjectId(req.params.id) }, update);
    res.status(result.matchedCount ? 200 : 404).json(result);
  }));
  app.delete('/post/:id', ...secured, wrap(async (req, res) => {
    const filter = { _id: new ObjectId(req.params.id) };
    const post = await req.db.posts.findOne(filter);
    if (!post) return res.status(404).json({ message: 'Post not found' });
    if (!owns(post, req.decoded)) return res.status(403).json({ message: 'Only the author can delete this post' });
    res.json(await req.db.posts.deleteOne(filter));
  }));
  app.get('/user/:email/posts', ...secured, ownEmail, wrap(async (req, res) => res.json((await req.db.posts.find({ authorEmail: req.decoded.email }).limit(100).toArray()).map(publicLegacyPost))));

  app.post('/comment', ...secured, wrap(async (req, res) => {
    if (!safeId(req.body.postId) || !text(req.body.comment, 5000)) return res.status(400).json({ message: 'Valid post and comment required' });
    const targetPost = await req.db.posts.findOne({ _id: new ObjectId(req.body.postId), visibility: { $ne: 'friends' } });
    if (!targetPost) return res.status(404).json({ message: 'Post not found' });
    if (await isBlocked(req.db, req.decoded.uid, targetPost.authorUid)) return res.status(403).json({ message: 'Interaction unavailable' });
    const profile = await req.db.users.findOne({ email: req.decoded.email });
    res.status(201).json(await req.db.comments.insertOne({ postId: req.body.postId, comment: req.body.comment.trim(),
      commenterUid: req.decoded.uid, commenterEmail: req.decoded.email, commenterName: profile?.name || req.decoded.name, createdAt: new Date().toISOString() }));
  }));
  app.get('/comment', ...privileged, wrap(async (req, res) => res.json(await req.db.comments.find().limit(100).toArray())));
  app.delete('/comment/:id', ...privileged, wrap(async (req, res) => res.json(await req.db.comments.deleteOne({ _id: new ObjectId(req.params.id) }))));
  app.get('/post/:postId/comments', database, wrap(async (req, res) => {
    if (!await req.db.posts.findOne({ _id: new ObjectId(req.params.postId), visibility: { $ne: 'friends' } })) return res.status(404).json({ message: 'Post not found' });
    res.json((await req.db.comments.find({ postId: req.params.postId }).limit(100).toArray()).map(({ commenterEmail, ...comment }) => comment));
  }));

  app.post('/announcements', ...privileged, wrap(async (req, res) => {
    if (!text(req.body.title, 300) || !text(req.body.description, 10000)) return res.status(400).json({ message: 'Title and description required' });
    res.status(201).json(await req.db.announcements.insertOne({ title: req.body.title, description: req.body.description,
      authorName: req.decoded.name, authorImage: req.decoded.picture, createdAt: new Date().toISOString() }));
  }));
  app.get('/announcements', database, wrap(async (req, res) => res.json(await req.db.announcements.find().limit(100).toArray())));
  app.post('/reports', ...secured, wrap(async (req, res) => {
    if (!safeId(req.body.commentId) || !text(req.body.report, 1000)) return res.status(400).json({ message: 'Valid comment and report required' });
    const comment = await req.db.comments.findOne({ _id: new ObjectId(req.body.commentId) });
    if (!comment) return res.status(404).json({ message: 'Comment not found' });
    res.status(201).json(await req.db.reports.insertOne({ report: req.body.report, reporterUid: req.decoded.uid,
      commentId: req.body.commentId, postId: comment.postId, comment: comment.comment, commenterEmail: comment.commenterEmail, createdAt: new Date().toISOString() }));
  }));
  app.get('/reports', ...privileged, wrap(async (req, res) => res.json(await req.db.reports.find().limit(100).toArray())));
  app.delete('/reports/:id', ...privileged, wrap(async (req, res) => res.json(await req.db.reports.deleteOne({ _id: new ObjectId(req.params.id) }))));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 400 || error.status === 413 ? error.status : 500).json({ message: 'Unable to process request' });
  });
  return app;
}
const app = createApp();
if (require.main === module) app.listen(process.env.PORT || 5000);
module.exports = { app, createApp, connectDatabase };
