const express = require('express');
const { ObjectId } = require('mongodb');
const { createFirebaseAuth } = require('./auth');
const { publicProfile, pairId } = require('./community');
const { cloudImage } = require('./media');
const { isBlocked, blockedUids, blockKey } = require('./safety');
const validId = value => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const optionalText = (value, max) => typeof value === 'string' && value.length <= max;
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const now = () => new Date().toISOString();
function createSocialRouter({ getCollections, authenticate = createFirebaseAuth() }) {
  const router = express.Router();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const database = wrap(async (req, res, next) => {
    try { req.db = await getCollections(); } catch { return res.status(503).json({ message: 'Your community is temporarily unavailable. Please try again.' }); }
    next();
  });
  const optionalAuth = (req, res, next) => req.headers.authorization ? authenticate(req, res, next) : next();
  const read = [optionalAuth, database]; const secure = [authenticate, database];
  router.param('id', (req, res, next, id) => validId(id) ? next() : res.status(400).json({ message: 'Invalid item' }));
  router.param('thread', (req, res, next, id) => /^[a-f\d]{64}$/.test(id) ? next() : res.status(400).json({ message: 'Invalid conversation' }));
  const profile = (db, uid) => db.users.findOne({ uid });
  const memberKey = (spaceId, uid) => pairId('space:' + spaceId, uid);
  async function notify(db, to, identity, kind, href) {
    if (!to || to === identity.uid || await isBlocked(db, to, identity.uid)) return;
    const actor = await profile(db, identity.uid);
    await db.notifications.insertOne({ recipientUid: to, actorUid: identity.uid, actorName: actor?.name || identity.name || 'A member', actorImage: actor?.userImage || '', kind, href, createdAt: now(), readAt: null });
  }
  async function getSpace(req, res, id = req.params.id, posts = false) {
    const space = await req.db.spaces.findOne({ _id: new ObjectId(id) });
    if (!space || await isBlocked(req.db, req.decoded?.uid, space.ownerUid)) { res.status(404).json({ message: 'This community space is unavailable' }); return null; }
    const membership = req.decoded ? await req.db.memberships.findOne({ _id: memberKey(id, req.decoded.uid) }) : null;
    if (membership?.status === 'banned') { res.status(403).json({ message: 'You no longer have access to this community space' }); return null; }
    const owner = req.decoded?.uid === space.ownerUid;
    const joined = owner || membership?.status === 'joined';
    if (posts && space.visibility === 'private' && !joined) { res.status(403).json({ message: 'Join this private group to see its conversations' }); return null; }
    return { ...space, membership: membership?.status || null, isOwner: owner, joined };
  }
  async function spaceDTO(db, space) {
    return { id: String(space._id), type: space.type, title: space.title, description: space.description, category: space.category,
      image: space.image || '', visibility: space.visibility, createdAt: space.createdAt, owner: publicProfile(await profile(db, space.ownerUid)),
      members: await db.memberships.countDocuments({ spaceId: String(space._id), status: 'joined' }),
      membership: space.membership || null, isOwner: !!space.isOwner, joined: !!space.joined };
  }
  // Groups and public pages share membership primitives, but only page owners publish.
  router.get('/spaces', ...read, wrap(async (req, res) => {
    const filters = [];
    if (['group', 'page'].includes(req.query.type)) filters.push({ type: req.query.type });
    const blocked = await blockedUids(req.db, req.decoded?.uid);
    if (blocked.length) filters.push({ ownerUid: { $nin: blocked } });
    if (req.query.q) filters.push({ title: { $regex: escape(String(req.query.q).slice(0, 80)), $options: 'i' } });
    if (req.query.mine === '1') {
      if (!req.decoded) return res.status(401).json({ message: 'Sign in to see your spaces' });
      const memberships = await req.db.memberships.find({ uid: req.decoded.uid, status: 'joined' }).toArray();
      filters.push({ _id: { $in: memberships.map(m => new ObjectId(m.spaceId)) } });
    }
    const spaces = await req.db.spaces.find(filters.length ? { $and: filters } : {}).sort({ _id: -1 }).limit(40).toArray();
    res.json({ items: await Promise.all(spaces.map(async space => {
      const m = req.decoded ? await req.db.memberships.findOne({ _id: memberKey(String(space._id), req.decoded.uid) }) : null;
      return spaceDTO(req.db, { ...space, membership: m?.status, isOwner: space.ownerUid === req.decoded?.uid, joined: m?.status === 'joined' });
    })) });
  }));
  router.post('/spaces', ...secure, wrap(async (req, res) => {
    const b = req.body;
    if (!['group', 'page'].includes(b.type) || !text(b.title, 120) || !text(b.description, 3000) || !text(b.category, 80) || (b.image && !cloudImage(b.image)) || (b.type === 'group' && !['public', 'private'].includes(b.visibility))) return res.status(400).json({ message: 'Check the title, description, category and image' });
    const record = { type: b.type, title: b.title.trim(), description: b.description.trim(), category: b.category.trim(), image: b.image || '', visibility: b.type === 'page' ? 'public' : b.visibility, ownerUid: req.decoded.uid, createdAt: now() };
    const result = await req.db.spaces.insertOne(record); const id = String(result.insertedId);
    await req.db.memberships.updateOne({ _id: memberKey(id, req.decoded.uid) }, { $setOnInsert: { spaceId: id, uid: req.decoded.uid, status: 'joined', joinedAt: now() } }, { upsert: true });
    res.status(201).json({ id, type: record.type });
  }));
  router.get('/spaces/:id', ...read, wrap(async (req, res) => { const space = await getSpace(req, res); if (space) res.json(await spaceDTO(req.db, space)); }));
  router.patch('/spaces/:id', ...secure, wrap(async (req, res) => {
    const space = await getSpace(req, res); if (!space) return;
    if (!space.isOwner) return res.status(403).json({ message: 'Only the owner can edit this space' });
    const b = req.body;
    if (!text(b.title, 120) || !text(b.description, 3000) || !text(b.category, 80) || (b.image && !cloudImage(b.image))) return res.status(400).json({ message: 'Check the space details' });
    const update = { title: b.title.trim(), description: b.description.trim(), category: b.category.trim() };
    if (b.image !== undefined) update.image = b.image || '';
    await req.db.spaces.updateOne({ _id: space._id }, { $set: update });
    res.json({ updated: true });
  }));
  router.delete('/spaces/:id', ...secure, wrap(async (req, res) => {
    const space = await getSpace(req, res); if (!space) return;
    if (!space.isOwner) return res.status(403).json({ message: 'Only the owner can delete this space' });
    await req.db.spaceComments.deleteMany({ spaceId: req.params.id }); await req.db.spacePosts.deleteMany({ spaceId: req.params.id });
    await req.db.memberships.deleteMany({ spaceId: req.params.id }); await req.db.spaces.deleteOne({ _id: space._id }); res.json({ deleted: true });
  }));
  router.put('/spaces/:id/membership', ...secure, wrap(async (req, res) => {
    const space = await getSpace(req, res); if (!space) return;
    if (typeof req.body.joined !== 'boolean') return res.status(400).json({ message: 'Choose whether to join' });
    if (space.isOwner) return res.status(400).json({ message: 'Owners stay members of their own space' });
    const key = memberKey(req.params.id, req.decoded.uid);
    if (!req.body.joined) { await req.db.memberships.deleteOne({ _id: key, uid: req.decoded.uid }); return res.json({ status: null }); }
    const status = space.visibility === 'private' ? 'pending' : 'joined';
    const result = await req.db.memberships.updateOne({ _id: key }, { $setOnInsert: { spaceId: req.params.id, uid: req.decoded.uid, status, joinedAt: now() } }, { upsert: true });
    if (result.upsertedCount && status === 'pending') await notify(req.db, space.ownerUid, req.decoded, 'group_request', `/groups/${req.params.id}`);
    res.json({ status: space.membership || status });
  }));
  router.get('/spaces/:id/members', ...secure, wrap(async (req, res) => {
    const space = await getSpace(req, res, req.params.id, true); if (!space) return;
    const rows = await req.db.memberships.find({ spaceId: req.params.id, status: space.isOwner ? { $in: ['joined', 'pending', 'banned'] } : 'joined' }).limit(100).toArray();
    res.json(await Promise.all(rows.map(async m => ({ person: publicProfile(await profile(req.db, m.uid)), status: m.status, owner: m.uid === space.ownerUid }))));
  }));
  router.patch('/spaces/:id/members/:uid', ...secure, wrap(async (req, res) => {
    const space = await getSpace(req, res); if (!space) return;
    if (!space.isOwner) return res.status(403).json({ message: 'Only the owner can manage members' });
    if (req.params.uid === space.ownerUid || !['joined', 'banned', 'remove'].includes(req.body.status)) return res.status(400).json({ message: 'Choose a valid member action' });
    const key = memberKey(req.params.id, req.params.uid);
    const member = await req.db.memberships.findOne({ _id: key });
    if (!member) return res.status(404).json({ message: 'Member not found' });
    if (req.body.status === 'remove') await req.db.memberships.deleteOne({ _id: key });
    else await req.db.memberships.updateOne({ _id: key }, { $set: { status: req.body.status } });
    if (member.status === 'pending' && req.body.status === 'joined') await notify(req.db, req.params.uid, req.decoded, 'group_accepted', `/groups/${req.params.id}`);
    res.json({ updated: true });
  }));
  async function spacePostDTO(db, post, uid) {
    return { id: String(post._id), content: post.content, image: post.image || '', author: publicProfile(await profile(db, post.authorUid)), createdAt: post.createdAt,
      likes: post.likes?.length || 0, liked: !!post.likes?.includes(uid), comments: await db.spaceComments.countDocuments({ postId: String(post._id) }), canEdit: post.authorUid === uid };
  }
  router.get('/spaces/:id/posts', ...read, wrap(async (req, res) => {
    const space = await getSpace(req, res, req.params.id, true); if (!space) return;
    const query = { spaceId: req.params.id }; const blocked = await blockedUids(req.db, req.decoded?.uid);
    if (blocked.length) query.authorUid = { $nin: blocked };
    if (req.query.cursor) { if (!validId(req.query.cursor)) return res.status(400).json({ message: 'Invalid page' }); query._id = { $lt: new ObjectId(req.query.cursor) }; }
    const rows = await req.db.spacePosts.find(query).sort({ _id: -1 }).limit(16).toArray();
    res.json({ items: await Promise.all(rows.slice(0, 15).map(p => spacePostDTO(req.db, p, req.decoded?.uid))), nextCursor: rows.length > 15 ? String(rows[14]._id) : null });
  }));
  router.post('/spaces/:id/posts', ...secure, wrap(async (req, res) => {
    const space = await getSpace(req, res, req.params.id, true); if (!space) return;
    if (!space.joined || (space.type === 'page' && !space.isOwner)) return res.status(403).json({ message: space.type === 'page' ? 'Only page owners can publish updates' : 'Join this group to post' });
    if (!text(req.body.content, 10000) || (req.body.image && !cloudImage(req.body.image))) return res.status(400).json({ message: 'Add a message and a valid image' });
    const record = { spaceId: req.params.id, authorUid: req.decoded.uid, content: req.body.content.trim(), image: req.body.image || '', likes: [], createdAt: now() };
    const result = await req.db.spacePosts.insertOne(record); res.status(201).json({ id: String(result.insertedId) });
  }));
  async function spacePost(req, res) {
    const post = await req.db.spacePosts.findOne({ _id: new ObjectId(req.params.id) });
    if (!post || await isBlocked(req.db, req.decoded?.uid, post.authorUid)) { res.status(404).json({ message: 'Conversation unavailable' }); return null; }
    const space = await getSpace(req, res, post.spaceId, true); return space ? { post, space } : null;
  }
  router.patch('/space-posts/:id', ...secure, wrap(async (req, res) => {
    const item = await spacePost(req, res); if (!item) return;
    if (item.post.authorUid !== req.decoded.uid) return res.status(403).json({ message: 'Only the author can edit this update' });
    if (!text(req.body.content, 10000)) return res.status(400).json({ message: 'Write a message' });
    await req.db.spacePosts.updateOne({ _id: item.post._id }, { $set: { content: req.body.content.trim() } }); res.json({ updated: true });
  }));
  router.delete('/space-posts/:id', ...secure, wrap(async (req, res) => {
    const item = await spacePost(req, res); if (!item) return;
    if (item.post.authorUid !== req.decoded.uid && !item.space.isOwner) return res.status(403).json({ message: 'Only the author or community owner can remove this update' });
    await req.db.spacePosts.deleteOne({ _id: item.post._id }); await req.db.spaceComments.deleteMany({ postId: req.params.id }); res.json({ deleted: true });
  }));
  router.put('/space-posts/:id/like', ...secure, wrap(async (req, res) => {
    const item = await spacePost(req, res); if (!item) return;
    if (typeof req.body.liked !== 'boolean') return res.status(400).json({ message: 'Choose an appreciation' });
    await req.db.spacePosts.updateOne({ _id: item.post._id }, req.body.liked ? { $addToSet: { likes: req.decoded.uid } } : { $pull: { likes: req.decoded.uid } }); res.json({ liked: req.body.liked });
  }));
  router.get('/space-posts/:id/comments', ...read, wrap(async (req, res) => {
    if (!await spacePost(req, res)) return;
    const blocked = await blockedUids(req.db, req.decoded?.uid);
    const rows = await req.db.spaceComments.find({ postId: req.params.id, authorUid: { $nin: blocked } }).sort({ _id: 1 }).limit(100).toArray();
    res.json(await Promise.all(rows.map(async row => ({ id: String(row._id), content: row.content, author: publicProfile(await profile(req.db, row.authorUid)), createdAt: row.createdAt }))));
  }));
  router.post('/space-posts/:id/comments', ...secure, wrap(async (req, res) => {
    const item = await spacePost(req, res); if (!item) return;
    if (item.space.type === 'group' && !item.space.joined) return res.status(403).json({ message: 'Join this group to reply' });
    if (!text(req.body.content, 5000)) return res.status(400).json({ message: 'Write a reply' });
    const result = await req.db.spaceComments.insertOne({ postId: req.params.id, spaceId: item.post.spaceId, authorUid: req.decoded.uid, content: req.body.content.trim(), createdAt: now() });
    await notify(req.db, item.post.authorUid, req.decoded, 'space_comment', `/${item.space.type === 'group' ? 'groups' : 'pages'}/${item.post.spaceId}`);
    res.status(201).json({ id: String(result.insertedId) });
  }));
  // Durable direct messages. Netlify-friendly clients refresh active threads automatically.
  async function threadFor(req, res) {
    const thread = await req.db.conversations.findOne({ _id: req.params.thread, members: req.decoded.uid });
    if (!thread) { res.status(404).json({ message: 'Conversation unavailable' }); return null; }
    return thread;
  }
  async function unreadCount(db, thread, uid) {
    const read = await db.conversationReads.findOne({ _id: pairId(thread._id, uid) });
    return db.messages.countDocuments({ conversationId: thread._id, senderUid: { $ne: uid }, createdAt: { $gt: read?.readAt || '' } });
  }
  router.get('/conversations/unread', ...secure, wrap(async (req, res) => {
    const threads = await req.db.conversations.find({ members: req.decoded.uid }).toArray();
    const counts = await Promise.all(threads.map(t => unreadCount(req.db, t, req.decoded.uid))); res.json({ unread: counts.reduce((a, b) => a + b, 0) });
  }));
  router.get('/conversations', ...secure, wrap(async (req, res) => {
    const threads = await req.db.conversations.find({ members: req.decoded.uid }).sort({ updatedAt: -1 }).limit(100).toArray();
    res.json(await Promise.all(threads.map(async t => ({ id: t._id, person: publicProfile(await profile(req.db, t.members.find(uid => uid !== req.decoded.uid))),
      preview: t.preview || '', updatedAt: t.updatedAt, unread: await unreadCount(req.db, t, req.decoded.uid) }))));
  }));
  router.post('/conversations', ...secure, wrap(async (req, res) => {
    const target = req.body.recipientUid;
    if (typeof target !== 'string' || target.length > 128 || target === req.decoded.uid) return res.status(400).json({ message: 'Choose another member' });
    const targetProfile = await profile(req.db, target);
    if (!targetProfile) return res.status(404).json({ message: 'Member unavailable' });
    if (targetProfile.isDemo) return res.status(400).json({ message: 'Demo profiles cannot receive messages' });
    if (await isBlocked(req.db, target, req.decoded.uid)) return res.status(403).json({ message: 'Messaging is unavailable between these accounts' });
    const id = pairId(req.decoded.uid, target);
    await req.db.conversations.updateOne({ _id: id }, { $setOnInsert: { members: [req.decoded.uid, target], createdAt: now(), updatedAt: now(), preview: '' } }, { upsert: true }); res.json({ id });
  }));
  router.get('/conversations/:thread/messages', ...secure, wrap(async (req, res) => {
    const thread = await threadFor(req, res); if (!thread) return;
    const query = { conversationId: thread._id };
    if (req.query.before) { if (!validId(req.query.before)) return res.status(400).json({ message: 'Invalid message page' }); query._id = { $lt: new ObjectId(req.query.before) }; }
    const rows = await req.db.messages.find(query).sort({ _id: -1 }).limit(51).toArray();
    const other = thread.members.find(uid => uid !== req.decoded.uid);
    res.json({ person: publicProfile(await profile(req.db, other)), blocked: await isBlocked(req.db, req.decoded.uid, other),
      blockedByMe: !!await req.db.blocks.findOne({ _id: blockKey(req.decoded.uid, other) }),
      otherReadAt: (await req.db.conversationReads.findOne({ _id: pairId(thread._id, other) }))?.readAt || null,
      items: rows.slice(0, 50).reverse().map(m => ({ id: String(m._id), senderUid: m.senderUid, content: m.content, image: m.image || '', createdAt: m.createdAt })),
      nextCursor: rows.length > 50 ? String(rows[49]._id) : null });
  }));
  router.post('/conversations/:thread/messages', ...secure, wrap(async (req, res) => {
    const thread = await threadFor(req, res); if (!thread) return;
    const other = thread.members.find(uid => uid !== req.decoded.uid);
    if (await isBlocked(req.db, req.decoded.uid, other)) return res.status(403).json({ message: 'Messaging is unavailable between these accounts' });
    if ((!text(req.body.content, 5000) && !cloudImage(req.body.image)) || (req.body.content !== undefined && !optionalText(req.body.content, 5000)) || (req.body.image && !cloudImage(req.body.image)) || typeof req.body.nonce !== 'string' || !/^[a-zA-Z\d-]{16,80}$/.test(req.body.nonce)) return res.status(400).json({ message: 'Add a message or photo' });
    const record = { conversationId: thread._id, senderUid: req.decoded.uid, content: req.body.content?.trim() || '', image: req.body.image || '', nonce: req.body.nonce, createdAt: now() };
    const result = await req.db.messages.updateOne({ conversationId: thread._id, senderUid: req.decoded.uid, nonce: req.body.nonce }, { $setOnInsert: record }, { upsert: true });
    if (result.upsertedCount) {
      await req.db.conversations.updateOne({ _id: thread._id }, { $set: { preview: record.content.slice(0, 100) || 'Shared a photo', updatedAt: record.createdAt } });
      if (!thread.preview) await notify(req.db, other, req.decoded, 'message', `/messages/${thread._id}`);
    }
    res.status(201).json({ sent: true });
  }));
  router.put('/conversations/:thread/read', ...secure, wrap(async (req, res) => {
    const thread = await threadFor(req, res); if (!thread) return;
    if (!validId(req.body.lastMessageId)) return res.status(400).json({ message: 'Choose a message that was displayed' });
    const message = await req.db.messages.findOne({ _id: new ObjectId(req.body.lastMessageId), conversationId: thread._id });
    if (!message) return res.status(404).json({ message: 'Message unavailable' });
    await req.db.conversationReads.updateOne({ _id: pairId(thread._id, req.decoded.uid) }, { $max: { readAt: message.createdAt }, $setOnInsert: { uid: req.decoded.uid, conversationId: thread._id } }, { upsert: true }); res.json({ read: true });
  }));
  router.get('/blocks', ...secure, wrap(async (req, res) => {
    const rows = await req.db.blocks.find({ ownerUid: req.decoded.uid }).limit(500).toArray(); res.json((await Promise.all(rows.map(row => profile(req.db, row.targetUid)))).filter(Boolean).map(publicProfile));
  }));
  router.put('/blocks/:uid', ...secure, wrap(async (req, res) => {
    const target = req.params.uid;
    if (target === req.decoded.uid || typeof req.body.blocked !== 'boolean' || !await profile(req.db, target)) return res.status(400).json({ message: 'Choose a valid member action' });
    const key = blockKey(req.decoded.uid, target);
    if (req.body.blocked) {
      await req.db.blocks.updateOne({ _id: key }, { $setOnInsert: { ownerUid: req.decoded.uid, targetUid: target, createdAt: now() } }, { upsert: true });
      await req.db.friendships.deleteOne({ _id: pairId(req.decoded.uid, target) });
      await req.db.notifications.deleteMany({ $or: [{ actorUid: target, recipientUid: req.decoded.uid }, { actorUid: req.decoded.uid, recipientUid: target }] });
    } else await req.db.blocks.deleteOne({ _id: key, ownerUid: req.decoded.uid });
    res.json({ blocked: req.body.blocked });
  }));
  // Expiry is checked on every read, independently of MongoDB's TTL cleanup.
  async function canViewStory(req, story) {
    if (!story || new Date(story.expiresAt).getTime() <= Date.now() || await isBlocked(req.db, req.decoded?.uid, story.ownerUid)) return false;
    return story.visibility === 'public' || story.ownerUid === req.decoded?.uid || !!(req.decoded && await req.db.friendships.findOne({ _id: pairId(req.decoded.uid, story.ownerUid), status: 'accepted' }));
  }
  async function storyDTO(req, story) {
    return { id: String(story._id), author: publicProfile(await profile(req.db, story.ownerUid)), content: story.content, image: story.image || '', color: story.color,
      createdAt: story.createdAt, expiresAt: story.expiresAt, visibility: story.visibility, canDelete: story.ownerUid === req.decoded?.uid,
      seen: !!req.decoded && !!await req.db.storyViews.findOne({ _id: pairId(String(story._id), req.decoded.uid) }),
      views: story.ownerUid === req.decoded?.uid ? await req.db.storyViews.countDocuments({ storyId: String(story._id), uid: { $ne: req.decoded.uid } }) : undefined };
  }
  router.get('/stories', ...read, wrap(async (req, res) => {
    const blocked = await blockedUids(req.db, req.decoded?.uid); const visibility = [{ visibility: 'public' }];
    if (req.decoded) {
      const friends = await req.db.friendships.find({ members: req.decoded.uid, status: 'accepted' }).toArray();
      visibility.push({ ownerUid: { $in: [req.decoded.uid, ...friends.flatMap(f => f.members)] } });
    }
    const rows = await req.db.stories.find({ expiresAt: { $gt: new Date() }, ownerUid: { $nin: blocked }, $or: visibility }).sort({ _id: -1 }).limit(50).toArray();
    res.json(await Promise.all(rows.map(story => storyDTO(req, story))));
  }));
  router.post('/stories', ...secure, wrap(async (req, res) => {
    if ((!text(req.body.content, 280) && !cloudImage(req.body.image)) || (req.body.content !== undefined && !optionalText(req.body.content, 280)) || (req.body.image && !cloudImage(req.body.image)) || !['lilac', 'sage', 'sunset', 'ink'].includes(req.body.color) || !['public', 'connections'].includes(req.body.visibility)) return res.status(400).json({ message: 'Add a moment and choose its audience' });
    const record = { ownerUid: req.decoded.uid, content: req.body.content?.trim() || '', image: req.body.image || '', color: req.body.color, visibility: req.body.visibility,
      createdAt: now(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    const result = await req.db.stories.insertOne(record); res.status(201).json({ id: String(result.insertedId), expiresAt: record.expiresAt });
  }));
  router.get('/stories/:id', ...read, wrap(async (req, res) => {
    const story = await req.db.stories.findOne({ _id: new ObjectId(req.params.id) });
    if (!await canViewStory(req, story)) return res.status(404).json({ message: 'This moment has passed or is unavailable' });
    res.json(await storyDTO(req, story));
  }));
  router.put('/stories/:id/view', ...secure, wrap(async (req, res) => {
    const story = await req.db.stories.findOne({ _id: new ObjectId(req.params.id) });
    if (!await canViewStory(req, story)) return res.status(404).json({ message: 'This story is unavailable' });
    await req.db.storyViews.updateOne({ _id: pairId(req.params.id, req.decoded.uid) }, { $setOnInsert: { storyId: req.params.id, uid: req.decoded.uid, expiresAt: story.expiresAt, viewedAt: now() } }, { upsert: true }); res.json({ viewed: true });
  }));
  router.delete('/stories/:id', ...secure, wrap(async (req, res) => {
    const story = await req.db.stories.findOne({ _id: new ObjectId(req.params.id) });
    if (!story || story.ownerUid !== req.decoded.uid) return res.status(403).json({ message: 'Only the author can remove this story' });
    await req.db.stories.deleteOne({ _id: story._id }); await req.db.storyViews.deleteMany({ storyId: req.params.id }); res.json({ deleted: true });
  }));
  // Events and a contact-based marketplace: no payment processing.
  function eventFields(b) {
    const date = new Date(b.startsAt);
    if (!text(b.title, 160) || !text(b.description, 5000) || !text(b.location, 200) || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || (b.image && !cloudImage(b.image))) return null;
    return { title: b.title.trim(), description: b.description.trim(), location: b.location.trim(), startsAt: date.toISOString(), image: b.image || '' };
  }
  async function eventDTO(req, event) {
    const id = String(event._id); const rsvp = req.decoded ? await req.db.rsvps.findOne({ _id: pairId(id, req.decoded.uid) }) : null;
    return { ...event, _id: undefined, ownerUid: undefined, id, host: publicProfile(await profile(req.db, event.ownerUid)), canEdit: event.ownerUid === req.decoded?.uid,
      going: await req.db.rsvps.countDocuments({ eventId: id, status: 'going' }), interested: await req.db.rsvps.countDocuments({ eventId: id, status: 'interested' }), myRSVP: rsvp?.status || null };
  }
  router.get('/events', ...read, wrap(async (req, res) => {
    const blocked = await blockedUids(req.db, req.decoded?.uid); const query = { ownerUid: { $nin: blocked } };
    if (req.query.past !== '1') query.startsAt = { $gte: now() };
    if (req.query.q) query.title = { $regex: escape(String(req.query.q).slice(0, 80)), $options: 'i' };
    if (req.query.mine === '1') { if (!req.decoded) return res.status(401).json({ message: 'Sign in to see your events' }); query.ownerUid = req.decoded.uid; }
    const events = await req.db.events.find(query).sort({ startsAt: 1 }).limit(40).toArray(); res.json(await Promise.all(events.map(e => eventDTO(req, e))));
  }));
  router.post('/events', ...secure, wrap(async (req, res) => {
    const fields = eventFields(req.body); if (!fields) return res.status(400).json({ message: 'Add a title, details, location and a future event date' });
    const result = await req.db.events.insertOne({ ...fields, ownerUid: req.decoded.uid, createdAt: now() }); res.status(201).json({ id: String(result.insertedId) });
  }));
  async function getEvent(req, res) {
    const event = await req.db.events.findOne({ _id: new ObjectId(req.params.id) });
    if (!event || await isBlocked(req.db, req.decoded?.uid, event.ownerUid)) { res.status(404).json({ message: 'Event unavailable' }); return null; } return event;
  }
  router.get('/events/:id', ...read, wrap(async (req, res) => { const event = await getEvent(req, res); if (event) res.json(await eventDTO(req, event)); }));
  router.patch('/events/:id', ...secure, wrap(async (req, res) => {
    const event = await getEvent(req, res); if (!event) return;
    if (event.ownerUid !== req.decoded.uid) return res.status(403).json({ message: 'Only the host can edit this event' });
    const fields = eventFields(req.body); if (!fields) return res.status(400).json({ message: 'Check the event details and date' });
    await req.db.events.updateOne({ _id: event._id }, { $set: fields }); res.json({ updated: true });
  }));
  router.delete('/events/:id', ...secure, wrap(async (req, res) => {
    const event = await getEvent(req, res); if (!event) return;
    if (event.ownerUid !== req.decoded.uid) return res.status(403).json({ message: 'Only the host can remove this event' });
    await req.db.events.deleteOne({ _id: event._id }); await req.db.rsvps.deleteMany({ eventId: req.params.id }); res.json({ deleted: true });
  }));
  router.put('/events/:id/rsvp', ...secure, wrap(async (req, res) => {
    const event = await getEvent(req, res); if (!event) return;
    if (!['going', 'interested', 'none'].includes(req.body.status)) return res.status(400).json({ message: 'Choose an RSVP' });
    const key = pairId(req.params.id, req.decoded.uid);
    if (req.body.status === 'none') await req.db.rsvps.deleteOne({ _id: key, uid: req.decoded.uid });
    else await req.db.rsvps.updateOne({ _id: key }, { $set: { status: req.body.status }, $setOnInsert: { eventId: req.params.id, uid: req.decoded.uid } }, { upsert: true });
    res.json({ status: req.body.status });
  }));
  function listingFields(b) {
    if (!text(b.title, 160) || !text(b.description, 5000) || !text(b.location, 160) || !Number.isFinite(b.price) || b.price < 0 || b.price > 1e9 || !['BDT', 'USD', 'EUR', 'GBP'].includes(b.currency) || !['new', 'good', 'fair'].includes(b.condition) || !text(b.category, 80) || !Array.isArray(b.images) || b.images.length > 4 || b.images.some(v => !cloudImage(v))) return null;
    return { title: b.title.trim(), description: b.description.trim(), location: b.location.trim(), price: b.price, currency: b.currency,
      condition: b.condition, category: b.category, images: b.images, status: ['available', 'sold'].includes(b.status) ? b.status : 'available' };
  }
  async function listingDTO(req, listing) { return { ...listing, _id: undefined, ownerUid: undefined, id: String(listing._id), seller: publicProfile(await profile(req.db, listing.ownerUid)), canEdit: listing.ownerUid === req.decoded?.uid }; }
  router.get('/listings', ...read, wrap(async (req, res) => {
    const blocked = await blockedUids(req.db, req.decoded?.uid); const query = { ownerUid: { $nin: blocked } };
    if (req.query.mine === '1') { if (!req.decoded) return res.status(401).json({ message: 'Sign in to see your listings' }); query.ownerUid = req.decoded.uid; }
    else query.status = 'available';
    if (req.query.q) query.title = { $regex: escape(String(req.query.q).slice(0, 80)), $options: 'i' };
    if (req.query.category) query.category = String(req.query.category).slice(0, 80);
    const rows = await req.db.listings.find(query).sort({ _id: -1 }).limit(50).toArray(); res.json(await Promise.all(rows.map(r => listingDTO(req, r))));
  }));
  router.post('/listings', ...secure, wrap(async (req, res) => {
    const fields = listingFields(req.body); if (!fields) return res.status(400).json({ message: 'Check your listing details, price and photos' });
    const result = await req.db.listings.insertOne({ ...fields, ownerUid: req.decoded.uid, createdAt: now() }); res.status(201).json({ id: String(result.insertedId) });
  }));
  async function getListing(req, res) {
    const item = await req.db.listings.findOne({ _id: new ObjectId(req.params.id) });
    if (!item || await isBlocked(req.db, req.decoded?.uid, item.ownerUid)) { res.status(404).json({ message: 'Listing unavailable' }); return null; } return item;
  }
  router.get('/listings/:id', ...read, wrap(async (req, res) => { const item = await getListing(req, res); if (item) res.json(await listingDTO(req, item)); }));
  router.patch('/listings/:id', ...secure, wrap(async (req, res) => {
    const item = await getListing(req, res); if (!item) return;
    if (item.ownerUid !== req.decoded.uid) return res.status(403).json({ message: 'Only the seller can edit this listing' });
    const fields = Object.keys(req.body).length === 1 && ['available', 'sold'].includes(req.body.status) ? { status: req.body.status } : listingFields(req.body);
    if (!fields) return res.status(400).json({ message: 'Check the listing details' });
    await req.db.listings.updateOne({ _id: item._id }, { $set: fields }); res.json({ updated: true });
  }));
  router.delete('/listings/:id', ...secure, wrap(async (req, res) => {
    const item = await getListing(req, res); if (!item) return;
    if (item.ownerUid !== req.decoded.uid) return res.status(403).json({ message: 'Only the seller can delete this listing' });
    await req.db.listings.deleteOne({ _id: item._id }); res.json({ deleted: true });
  }));
  return router;
}
module.exports = { createSocialRouter };
