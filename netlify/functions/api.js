const serverless = require('serverless-http');
const { app } = require('../../index');
const handle = serverless(app);

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  const path = event.path.replace(/^\/(?:\.netlify\/functions\/api|api)(?=\/|$)/, '') || '/';
  return handle({ ...event, path }, context);
};
