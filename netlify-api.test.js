const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('./netlify/functions/api');

function event(path, httpMethod = 'GET') {
  return { path, httpMethod, headers: { host: 'backend.example', origin: 'https://frontend.example' },
    queryStringParameters: {}, body: null, isBase64Encoded: false, requestContext: {} };
}
test('Netlify adapter maps both public and function paths', async () => {
  for (const path of ['/api/', '/.netlify/functions/api/']) {
    const res = await handler(event(path), {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'is running');
  }
});
test('signature endpoint rejects anonymous users through Netlify without a database', async () => {
  const res = await handler(event('/.netlify/functions/api/uploads/signature', 'POST'), {});
  assert.equal(res.statusCode, 401);
});
test('CORS preflight succeeds without waiting for MongoDB', async () => {
  const res = await handler(event('/api/post', 'OPTIONS'), {});
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], '*');
});
