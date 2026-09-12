import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { HostSampler } from './metrics';

const host = process.env.HOST_AGENT_HOST || '127.0.0.1';
const port = Number(process.env.HOST_AGENT_PORT || 8320);
const keyFile = resolve(
  (process.env.HOST_AGENT_KEY_FILE || '~/.config/cliproxyapi/management-key').replace(
    /^~(?=\/)/,
    homedir()
  )
);
const sampler = new HostSampler();

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      response.setHeader('Vary', 'Origin');
    }
  } catch {
    // Invalid Origin values are deliberately ignored.
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function isAuthorized(request: IncomingMessage): Promise<boolean> {
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;

  try {
    const expected = (await readFile(keyFile, 'utf8')).trim();
    const expectedBuffer = Buffer.from(expected);
    const presentedBuffer = Buffer.from(presented);
    return (
      expectedBuffer.length > 0 &&
      expectedBuffer.length === presentedBuffer.length &&
      timingSafeEqual(expectedBuffer, presentedBuffer)
    );
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  setCorsHeaders(request, response);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (requestPath === '/healthz' || requestPath === '/host/healthz') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (request.method !== 'GET' || !['/v1/snapshot', '/host/v1/snapshot'].includes(requestPath)) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (!(await isAuthorized(request))) {
    response.setHeader('WWW-Authenticate', 'Bearer realm="host-agent"');
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    sendJson(response, 200, await sampler.sample());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Host sampling failed';
    sendJson(response, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`CLI Proxy host agent listening on http://${host}:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
