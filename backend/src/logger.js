const pino = require('pino');

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

/** @type {import('pino').Logger} */
const logger = pino({
  level,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["set-cookie"]',
      'password',
      'req.body.password',
      'req.body.S3_SECRET_ACCESS_KEY',
    ],
    remove: true,
  },
});

module.exports = { logger };
