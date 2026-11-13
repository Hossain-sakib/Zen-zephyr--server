function createFirebaseAuth({ env = process.env, fetchImpl = fetch } = {}) {
  return async (req, res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
    if (!token) return res.status(401).json({ message: 'Sign in required' });
    const key = env.FIREBASE_WEB_API_KEY || env.VITE_apiKey;
    if (!key) return res.status(503).json({ message: 'Authentication is not configured' });
    try {
      const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return res.status(response.status >= 500 ? 503 : 401).json({ message: 'Unable to verify sign-in' });
      const user = (await response.json()).users?.[0];
      if (!user?.localId || !user.email || user.disabled) return res.status(401).json({ message: 'Invalid sign-in' });
      req.decoded = { uid: user.localId, email: user.email, name: user.displayName || '', picture: user.photoUrl || '' };
      return next();
    } catch {
      return res.status(503).json({ message: 'Authentication temporarily unavailable' });
    }
  };
}
module.exports = { createFirebaseAuth };
