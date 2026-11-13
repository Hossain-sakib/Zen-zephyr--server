const { createHash } = require('node:crypto');
const blockKey = (owner, target) => createHash('sha256').update(JSON.stringify(['block', owner, target])).digest('hex');
async function isBlocked(db, a, b) {
  if (!a || !b || a === b) return false;
  return !!await db.blocks.findOne({ $or: [{ ownerUid: a, targetUid: b }, { ownerUid: b, targetUid: a }] });
}
async function blockedUids(db, uid) {
  if (!uid) return [];
  const rows = await db.blocks.find({ $or: [{ ownerUid: uid }, { targetUid: uid }] }).toArray();
  return rows.map(row => row.ownerUid === uid ? row.targetUid : row.ownerUid);
}
module.exports = { blockKey, isBlocked, blockedUids };
