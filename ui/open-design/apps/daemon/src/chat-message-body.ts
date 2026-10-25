import express, { type RequestHandler } from 'express';

export const CHAT_MESSAGE_BODY_LIMIT_BYTES = 32 * 1024 * 1024;
const messageWritePath = /^\/api\/projects\/[^/]+\/conversations\/[^/]+\/messages\/[^/]+\/?$/;

/** Initial message writes carry the full file baseline needed after reload. */
export function createChatMessageBodyParser(): RequestHandler {
  const parse = express.json({ limit: CHAT_MESSAGE_BODY_LIMIT_BYTES });
  return (req, res, next) => {
    if (req.method !== 'PUT' || !messageWritePath.test(req.path)) {
      next();
      return;
    }
    parse(req, res, next);
  };
}
