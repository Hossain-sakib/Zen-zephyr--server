const express = require('express');
const { ObjectId } = require('mongodb');
const { createHash } = require('node:crypto');
const { createFirebaseAuth } = require('./auth');
const { cloudImage, profileImage } = require('./media');
const { isBlocked, blockedUids } = require('./safety');
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const image = cloudImage;
const pairId = (a, b) => createHash('sha256').update(JSON.stringify([a, b].sort())).digest('hex');
const publicProfile = user => user && ({ id: user.uid || String(user._id), name: user.name || 'Community member',
  image: user.userImage || '', isDemo: !!user.isDemo, bio: user.bio || '', location: user.location || '', joinedAt: user.joinedAt || null });
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function createCommunityRouter({ getCollections, authenticate = createFirebaseAuth() }) {
  const router = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const database = wrap(async (req, res, next) => {
    try { req.db = await getCollections(); } catch { return res.status(503).json({ message: 'The community is temporarily unavailable. Please try again shortly.' }); }
    next();
  });
  const optionalAuth = (req, res, next) => req.headers.authorization ? authenticate(req, res, next) : next();
  const secure = [authenticate, database];
  const read = [optionalAuth, database];
  router.param('id', (req, res, next, id) => validId(id) ? next() : res.status(400).json({ message: 'Invalid post ID' }));
  const profileFor = (db, identity) => db.users.findOne(identity.uid ? { uid: identity.uid } : { email: identity.email });
  async function ensureProfile(db, identity) {
    const existing = await db.users.findOne({ email: identity.email });
    const initialImage = existing ? existing.userImage || '' : await profileImage(identity.picture);
    await db.users.updateOne({ email: identity.email }, { $set: { uid: identity.uid }, $setOnInsert: {
      email: identity.email, name: identity.name || 'Community member', userImage: initialImage,
      role: 'user', badge: 'bronze', bio: '', location: '', joinedAt: new Date().toISOString(),
    } }, { upsert: true });
    return profileFor(db, identity);
  }
  async function notify(db, recipientUid, identity, kind, postId) {
    if (!recipientUid || recipientUid === identity.uid || await isBlocked(db, recipientUid, identity.uid)) return;
    if ((await db.users.findOne({ uid: recipientUid }))?.isDemo) return;
    const actor = await profileFor(db, identity);
    await db.notifications.insertOne({ recipientUid, actorUid: identity.uid, actorName: actor?.name || identity.name || 'A member',
      actorImage: actor?.userImage || identity.picture || '', kind, postId: postId || null, readAt: null, createdAt: new Date().toISOString() });
  }
  async function visible(db, post, identity) {
    if (!post || await isBlocked(db, identity?.uid, post.authorUid)) return false;
    if (!post.visibility || post.visibility === 'public') return true;
    if (!identity) return false;
    if (post.authorUid === identity.uid || post.authorEmail === identity.email) return true;
    if (!post.authorUid) return false;
    return !!await db.friendships.findOne({ _id: pairId(identity.uid, post.authorUid), status: 'accepted' });
  }
  async function findVisible(req, res) {
    const post = await req.db.posts.findOne({ _id: new ObjectId(req.params.id) });
    if (!await visible(req.db, post, req.decoded)) { res.status(404).json({ message: 'This post is unavailable' }); return null; }
    return post;
  }
  async function postDTO(db, post, identity) {
    const profile = post.authorUid ? await db.users.findOne({ uid: post.authorUid }) : await db.users.findOne({ email: post.authorEmail });
    const saved = identity ? await db.saved.findOne({ _id: pairId(identity.uid, String(post._id)) }) : null;
    return { id: String(post._id), isDemo: !!post.isDemo, title: post.title || '', content: post.description || '', topic: post.tag || 'Everyday life',
      image: post.imageUrl || '', visibility: post.visibility || 'public', createdAt: post.createdAt,
      author: profile ? publicProfile(profile) : { id: post.authorUid || null, name: post.authorName || 'Community member', image: post.authorImage || '' },
      likes: post.upVotes?.length || 0, liked: !!identity && !!post.upVotes?.includes(identity.email), saved: !!saved,
      comments: await db.comments.countDocuments({ postId: String(post._id) }),
      canEdit: !!identity && (post.authorUid ? post.authorUid === identity.uid : post.authorEmail === identity.email) };
  }
  async function postAuthorUid(db, post) {
    return post.authorUid || (await db.users.findOne({ email: post.authorEmail }))?.uid;
  }
  router.get('/stats', database, wrap(async (req, res) => res.json({ members: await req.db.users.countDocuments(), demoMembers: await req.db.users.countDocuments({ isDemo: true }), posts: await req.db.posts.countDocuments({ visibility: { $ne: 'friends' } }) })));
  router.get('/me', ...secure, wrap(async (req, res) => {
    const profile = await ensureProfile(req.db, req.decoded);
    res.json({ ...publicProfile(profile), isAdmin: profile.role === 'admin',
      postCount: await req.db.posts.countDocuments({ $or: [{ authorUid: req.decoded.uid }, { authorEmail: req.decoded.email }] }),
      connectionCount: await req.db.friendships.countDocuments({ members: req.decoded.uid, status: 'accepted' }) });
  }));
  router.patch('/me', ...secure, wrap(async (req, res) => {
    if (!text(req.body.name, 120) || typeof req.body.bio !== 'string' || req.body.bio.length > 240 || typeof req.body.location !== 'string' || req.body.location.length > 100) {
      return res.status(400).json({ message: 'Check your name, bio and location' });
    }
    await ensureProfile(req.db, req.decoded);
    const updates = { name: req.body.name.trim(), bio: req.body.bio.trim(), location: req.body.location.trim() };
    if (req.body.image) {
      if (!image(req.body.image)) return res.status(400).json({ message: 'Choose a valid profile image' });
      updates.userImage = req.body.image;
    }
    await req.db.users.updateOne({ uid: req.decoded.uid }, { $set: updates });
    res.json(publicProfile(await profileFor(req.db, req.decoded)));
  }));
  router.get('/profiles/:uid', ...read, wrap(async (req, res) => {
    const query = validId(req.params.uid) ? { $or: [{ uid: req.params.uid }, { _id: new ObjectId(req.params.uid) }] } : { uid: req.params.uid };
    const profile = await req.db.users.findOne(query);
    if (!profile || await isBlocked(req.db, req.decoded?.uid, profile.uid)) return res.status(404).json({ message: 'Member not found' });
    const connection = req.decoded && profile.uid ? await req.db.friendships.findOne({ _id: pairId(req.decoded.uid, profile.uid) }) : null;
    res.json({ ...publicProfile(profile), connection: connection?.status || null, incoming: connection?.recipientUid === req.decoded?.uid,
      postCount: await req.db.posts.countDocuments({ $or: [{ authorUid: profile.uid || 'no-uid' }, ...(profile.email ? [{ authorEmail: profile.email }] : [])], visibility: { $ne: 'friends' } }),
      connectionCount: profile.uid ? await req.db.friendships.countDocuments({ members: profile.uid, status: 'accepted' }) : 0 });
  }));
  router.get('/people', ...read, wrap(async (req, res) => {
    const q = String(req.query.q || '').slice(0, 80);
    const query = q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {};
    if (req.decoded) { query.email = { $ne: req.decoded.email }; query.uid = { $nin: await blockedUids(req.db, req.decoded.uid) }; }
    const people = await req.db.users.find(query).limit(40).toArray();
    res.json(await Promise.all(people.map(async profile => {
      const relation = req.decoded && profile.uid ? await req.db.friendships.findOne({ _id: pairId(req.decoded.uid, profile.uid) }) : null;
      return { ...publicProfile(profile), canConnect: !!profile.uid && !profile.isDemo, connection: relation?.status || null, incoming: relation?.recipientUid === req.decoded?.uid };
    })));
  }));
  router.get('/connections', ...secure, wrap(async (req, res) => {
    const relations = await req.db.friendships.find({ members: req.decoded.uid }).limit(100).toArray();
    const result = await Promise.all(relations.map(async relation => ({ id: relation._id, status: relation.status,
      incoming: relation.recipientUid === req.decoded.uid,
      person: publicProfile(await req.db.users.findOne({ uid: relation.members.find(uid => uid !== req.decoded.uid) })) })));
    res.json(result.filter(item => item.person));
  }));
  router.post('/connections/:uid', ...secure, wrap(async (req, res) => {
    const target = req.params.uid;
    if (await isBlocked(req.db, req.decoded.uid, target)) return res.status(403).json({ message: 'Connection unavailable' });
    if (target === req.decoded.uid) return res.status(400).json({ message: 'You cannot connect with yourself' });
    const targetProfile = await req.db.users.findOne({ uid: target });
    if (!targetProfile) return res.status(404).json({ message: 'Member not found' });
    if (targetProfile.isDemo) return res.status(400).json({ message: 'This is a fictional demo profile' });
    await ensureProfile(req.db, req.decoded);
    const result = await req.db.friendships.updateOne({ _id: pairId(req.decoded.uid, target) }, { $setOnInsert: {
      members: [req.decoded.uid, target], senderUid: req.decoded.uid, recipientUid: target, status: 'pending', createdAt: new Date().toISOString(),
    } }, { upsert: true });
    if (result.upsertedCount) await notify(req.db, target, req.decoded, 'friend_request');
    res.json({ status: 'pending' });
  }));
  router.patch('/connections/:uid', ...secure, wrap(async (req, res) => {
    if (await isBlocked(req.db, req.decoded.uid, req.params.uid)) return res.status(403).json({ message: 'Connection unavailable' });
    const relation = await req.db.friendships.findOneAndUpdate({ _id: pairId(req.decoded.uid, req.params.uid), recipientUid: req.decoded.uid, status: 'pending' }, { $set: { status: 'accepted' } }, { returnDocument: 'after' });
    if (!relation) return res.status(409).json({ message: 'This request is no longer available' });
    await notify(req.db, relation.senderUid, req.decoded, 'friend_accepted');
    res.json({ status: 'accepted' });
  }));
  router.delete('/connections/:uid', ...secure, wrap(async (req, res) => {
    await req.db.friendships.deleteOne({ _id: pairId(req.decoded.uid, req.params.uid), members: req.decoded.uid });
    res.json({ removed: true });
  }));
  router.get('/feed', ...read, wrap(async (req, res) => {
    const limit = 15;
    const filters = [{ $or: [{ visibility: { $ne: 'friends' } }, ...(req.decoded ? [{ authorUid: req.decoded.uid }] : [])] }];
    if (req.decoded) {
      const relations = await req.db.friendships.find({ members: req.decoded.uid, status: 'accepted' }).limit(500).toArray();
      const friends = relations.flatMap(r => r.members).filter(uid => uid !== req.decoded.uid);
      filters[0].$or.push({ authorUid: { $in: friends } });
      if (req.query.view === 'friends') filters.push({ authorUid: { $in: [...friends, req.decoded.uid] } });
      if (req.query.view === 'saved') {
        const saved = await req.db.saved.find({ uid: req.decoded.uid }).limit(500).toArray();
        filters.push({ _id: { $in: saved.map(item => new ObjectId(item.postId)) } });
      }
    } else if (req.query.view === 'friends' || req.query.view === 'saved') return res.status(401).json({ message: 'Sign in to view your community' });
    const blocked = await blockedUids(req.db, req.decoded?.uid);
    if (blocked.length) filters.push({ authorUid: { $nin: blocked } });
    if (req.query.cursor) {
      if (!validId(req.query.cursor)) return res.status(400).json({ message: 'Invalid page' });
      filters.push({ _id: { $lt: new ObjectId(req.query.cursor) } });
    }
    if (req.query.q) {
      const search = { $regex: escapeRegex(String(req.query.q).slice(0, 100)), $options: 'i' };
      filters.push({ $or: [{ title: search }, { description: search }, { authorName: search }] });
    }
    if (req.query.topic) filters.push({ tag: { $regex: '^' + escapeRegex(String(req.query.topic).slice(0, 100)) + '$', $options: 'i' } });
    if (req.query.author) {
      const author = String(req.query.author);
      const profile = await req.db.users.findOne(validId(author) ? { $or: [{ uid: author }, { _id: new ObjectId(author) }] } : { uid: author });
      filters.push(profile ? { $or: [{ authorUid: profile.uid || 'no-uid' }, ...(profile.email ? [{ authorEmail: profile.email }] : [])] } : { _id: null });
    }
    const posts = await req.db.posts.find({ $and: filters }).sort({ _id: -1 }).limit(limit + 1).toArray();
    res.json({ items: await Promise.all(posts.slice(0, limit).map(post => postDTO(req.db, post, req.decoded))),
      nextCursor: posts.length > limit ? String(posts[limit - 1]._id) : null });
  }));
  router.post('/posts', ...secure, wrap(async (req, res) => {
    if (!text(req.body.content, 20000) || !text(req.body.topic, 100) || !['public', 'friends'].includes(req.body.visibility)) return res.status(400).json({ message: 'Add your message, topic and audience' });
    if (req.body.image && !image(req.body.image)) return res.status(400).json({ message: 'Invalid photo' });
    const profile = await ensureProfile(req.db, req.decoded);
    const post = { authorUid: req.decoded.uid, authorEmail: req.decoded.email, authorName: profile.name, authorImage: profile.userImage,
      title: req.body.content.trim().split('\n')[0].slice(0, 100), description: req.body.content.trim(), tag: req.body.topic,
      visibility: req.body.visibility, imageUrl: req.body.image || '', upVotes: [], downVotes: [], createdAt: new Date().toISOString() };
    const result = await req.db.posts.insertOne(post);
    res.status(201).json(await postDTO(req.db, { ...post, _id: result.insertedId }, req.decoded));
  }));
  router.get('/posts/:id', ...read, wrap(async (req, res) => {
    const post = await findVisible(req, res); if (post) res.json(await postDTO(req.db, post, req.decoded));
  }));
  router.patch('/posts/:id', ...secure, wrap(async (req, res) => {
    const post = await findVisible(req, res); if (!post) return;
    if (post.authorUid ? post.authorUid !== req.decoded.uid : post.authorEmail !== req.decoded.email) return res.status(403).json({ message: 'Only the author can edit this post' });
    if (!text(req.body.content, 20000)) return res.status(400).json({ message: 'Write a message first' });
    await req.db.posts.updateOne({ _id: post._id }, { $set: { description: req.body.content.trim(), title: req.body.content.trim().split('\n')[0].slice(0, 100), updatedAt: new Date().toISOString() } });
    res.json({ updated: true });
  }));
  router.delete('/posts/:id', ...secure, wrap(async (req, res) => {
    const post = await findVisible(req, res); if (!post) return;
    if (post.authorUid ? post.authorUid !== req.decoded.uid : post.authorEmail !== req.decoded.email) return res.status(403).json({ message: 'Only the author can remove this post' });
    await req.db.posts.deleteOne({ _id: post._id });
    await req.db.comments.deleteMany({ postId: req.params.id });
    await req.db.saved.deleteMany({ postId: req.params.id });
    res.json({ deleted: true });
  }));
  router.put('/posts/:id/like', ...secure, wrap(async (req, res) => {
    const post = await findVisible(req, res); if (!post) return;
    if (typeof req.body.liked !== 'boolean') return res.status(400).json({ message: 'Choose a reaction' });
    const result = await req.db.posts.updateOne({ _id: post._id }, req.body.liked
      ? { $addToSet: { upVotes: req.decoded.email }, $pull: { downVotes: req.decoded.email } }
      : { $pull: { upVotes: req.decoded.email } });
    if (result.modifiedCount && req.body.liked) await notify(req.db, await postAuthorUid(req.db, post), req.decoded, 'like', req.params.id);
    res.json({ liked: req.body.liked });
  }));
  router.put('/posts/:id/save', ...secure, wrap(async (req, res) => {
    const post = await findVisible(req, res); if (!post) return;
    if (typeof req.body.saved !== 'boolean') return res.status(400).json({ message: 'Choose whether to save this post' });
    const _id = pairId(req.decoded.uid, req.params.id);
    if (req.body.saved) await req.db.saved.updateOne({ _id }, { $setOnInsert: { uid: req.decoded.uid, postId: req.params.id, createdAt: new Date().toISOString() } }, { upsert: true });
    else await req.db.saved.deleteOne({ _id, uid: req.decoded.uid });
    res.json({ saved: req.body.saved });
  }));
  router.get('/posts/:id/comments', ...read, wrap(async (req, res) => {
    if (!await findVisible(req, res)) return;
    const comments = await req.db.comments.find({ postId: req.params.id }).sort({ _id: 1 }).limit(100).toArray();
    res.json(comments.map(comment => ({ id: String(comment._id), content: comment.comment, createdAt: comment.createdAt,
      author: { id: comment.commenterUid || null, name: comment.commenterName || 'Community member', image: comment.commenterImage || '', isDemo: !!comment.isDemo } })));
  }));
  router.post('/posts/:id/comments', ...secure, wrap(async (req, res) => {
    const post = await findVisible(req, res); if (!post) return;
    if (!text(req.body.content, 5000)) return res.status(400).json({ message: 'Write a comment first' });
    const profile = await ensureProfile(req.db, req.decoded);
    const comment = { postId: req.params.id, comment: req.body.content.trim(), commenterUid: req.decoded.uid,
      commenterName: profile.name, commenterImage: profile.userImage, commenterEmail: req.decoded.email, createdAt: new Date().toISOString() };
    const result = await req.db.comments.insertOne(comment);
    await notify(req.db, await postAuthorUid(req.db, post), req.decoded, 'comment', req.params.id);
    res.status(201).json({ id: String(result.insertedId) });
  }));
  router.post('/posts/:id/report', ...secure, wrap(async (req, res) => {
    const post = await findVisible(req, res); if (!post) return;
    if (!text(req.body.reason, 1000)) return res.status(400).json({ message: 'Tell us what is wrong with this post' });
    await req.db.reports.insertOne({ postId: req.params.id, report: req.body.reason.trim(), reporterUid: req.decoded.uid, createdAt: new Date().toISOString(), type: 'post' });
    res.status(201).json({ received: true });
  }));
  router.get('/notifications', ...secure, wrap(async (req, res) => {
    const items = await req.db.notifications.find({ recipientUid: req.decoded.uid }).sort({ _id: -1 }).limit(50).toArray();
    res.json({ unread: await req.db.notifications.countDocuments({ recipientUid: req.decoded.uid, readAt: null }),
      items: items.map(item => ({ id: String(item._id), actor: { id: item.actorUid, name: item.actorName, image: item.actorImage },
        kind: item.kind, postId: item.postId, link: item.href || null, read: !!item.readAt, createdAt: item.createdAt })) });
  }));
  router.patch('/notifications/read', ...secure, wrap(async (req, res) => {
    await req.db.notifications.updateMany({ recipientUid: req.decoded.uid, readAt: null }, { $set: { readAt: new Date().toISOString() } });
    res.json({ updated: true });
  }));
  const moderator = wrap(async (req, res, next) => {
    if ((await profileFor(req.db, req.decoded))?.role !== 'admin') return res.status(403).json({ message: 'Moderator access required' });
    next();
  });
  router.get('/moderation/reports', ...secure, moderator, wrap(async (req, res) => {
    const reports = await req.db.reports.find().sort({ _id: -1 }).limit(100).toArray();
    res.json(reports.map(report => ({ id: String(report._id), type: report.type || 'comment',
      postId: report.postId, commentId: report.commentId, reason: report.report,
      content: report.comment || '', createdAt: report.createdAt })));
  }));
  router.delete('/moderation/reports/:id', ...secure, moderator, wrap(async (req, res) => {
    await req.db.reports.deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ dismissed: true });
  }));
  router.delete('/moderation/content/:id', ...secure, moderator, wrap(async (req, res) => {
    const report = await req.db.reports.findOne({ _id: new ObjectId(req.params.id) });
    if (!report) return res.status(404).json({ message: 'Report no longer available' });
    if (report.type === 'post' && validId(report.postId)) {
      await req.db.posts.deleteOne({ _id: new ObjectId(report.postId) });
      await req.db.comments.deleteMany({ postId: report.postId });
      await req.db.saved.deleteMany({ postId: report.postId });
    } else if (validId(report.commentId)) await req.db.comments.deleteOne({ _id: new ObjectId(report.commentId) });
    await req.db.reports.deleteOne({ _id: report._id });
    res.json({ removed: true });
  }));
  return router;
}
module.exports = { createCommunityRouter, pairId, publicProfile };
