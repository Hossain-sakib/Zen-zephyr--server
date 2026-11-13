const { createHash } = require('node:crypto');

// Only server-chosen parameters are signed. Never accept arbitrary transformations
// or public IDs from the browser.
function createUploadHandler({ env = process.env, fetchImpl = fetch } = {}) {
  return async (req, res) => {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ message: 'Sign in to upload an image' });
    const firebaseKey = env.FIREBASE_WEB_API_KEY || env.VITE_apiKey;
    if (!firebaseKey || !env.CLOUDINARY_URL || !env.CLOUDINARY_UPLOAD_PRESET) {
      return res.status(503).json({ message: 'Image uploads are not configured' });
    }
    try {
      const config = new URL(env.CLOUDINARY_URL);
      if (config.protocol !== 'cloudinary:' || !config.username || !config.password || !/^[a-z0-9_-]+$/i.test(config.hostname)) {
        throw new Error('Invalid upload configuration');
      }
      const identity = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: match[1] }), signal: AbortSignal.timeout(10000),
      });
      if (!identity.ok) {
        return res.status(identity.status >= 500 ? 503 : 401).json({ message: 'Unable to verify sign-in' });
      }
      const { users } = await identity.json();
      if (!users?.[0]?.localId || users[0].disabled) return res.status(401).json({ message: 'Invalid sign-in' });
      const params = {
        folder: `zen-zephyr/profiles/${encodeURIComponent(users[0].localId)}`,
        overwrite: false,
        timestamp: Math.floor(Date.now() / 1000),
        upload_preset: env.CLOUDINARY_UPLOAD_PRESET,
      };
      const payload = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
      const signature = createHash('sha1').update(payload + decodeURIComponent(config.password)).digest('hex');
      res.set('Cache-Control', 'no-store');
      return res.json({ cloudName: config.hostname, apiKey: decodeURIComponent(config.username), params, signature });
    } catch {
      // Do not leak URL credentials, upstream responses or Firebase tokens.
      return res.status(503).json({ message: 'Image uploads are temporarily unavailable' });
    }
  };
}

module.exports = { createUploadHandler };
