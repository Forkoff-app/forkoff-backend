import { Logger } from '@nestjs/common';
import type { Request, RequestHandler, Response } from 'express';
import * as https from 'https';
import { GatewayAuthService } from './gateway-auth.service';

const UPSTREAM_HOST = 'api.anthropic.com';
const OAUTH_BETA = 'oauth-2025-04-20';

const STRIPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'authorization',
  'x-api-key',
]);

export function buildUpstreamHeaders(
  incoming: Record<string, string | string[] | undefined>,
  oauthToken: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || STRIPPED_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  out['authorization'] = `Bearer ${oauthToken}`;
  const beta = out['anthropic-beta'];
  const betaStr = Array.isArray(beta) ? beta.join(',') : beta;
  if (!betaStr) {
    out['anthropic-beta'] = OAUTH_BETA;
  } else if (!betaStr.split(',').map((v) => v.trim()).includes(OAUTH_BETA)) {
    out['anthropic-beta'] = `${betaStr},${OAUTH_BETA}`;
  }
  return out;
}

function stripResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') continue;
    out[name] = value;
  }
  return out;
}

function extractKey(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer fkgw_')) {
    return auth.slice(7);
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.startsWith('fkgw_')) {
    return apiKey;
  }
  return null;
}

function sendJson(res: Response, status: number, body: object): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createGatewayProxy(auth: GatewayAuthService): RequestHandler {
  const logger = new Logger('GatewayProxy');
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });

  return async (req: Request, res: Response) => {
    const started = Date.now();
    const method = req.method || 'GET';
    const path = req.url || '/';

    const rawKey = extractKey(req);
    if (!rawKey) {
      sendJson(res, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'Missing gateway key' },
      });
      return;
    }

    let resolved;
    try {
      resolved = await auth.resolveKey(rawKey);
    } catch (error) {
      logger.error(`Key resolution failed: ${error instanceof Error ? error.message : String(error)}`);
      sendJson(res, 500, {
        type: 'error',
        error: { type: 'api_error', message: 'Gateway error' },
      });
      return;
    }
    if (!resolved) {
      sendJson(res, 401, {
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid or revoked gateway key' },
      });
      return;
    }

    const upstreamReq = https.request(
      {
        host: UPSTREAM_HOST,
        method,
        path,
        headers: buildUpstreamHeaders(req.headers, resolved.oauthToken),
        agent,
        timeout: 300_000,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, stripResponseHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => {
          logger.log(
            `${method} ${path} ${upstreamRes.statusCode} ${Date.now() - started}ms user=${resolved.userId}`,
          );
        });
      },
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Upstream response timeout'));
    });

    upstreamReq.on('error', (error) => {
      logger.error(`${method} ${path} upstream error: ${error.message} user=${resolved.userId}`);
      sendJson(res, 502, {
        type: 'error',
        error: { type: 'api_error', message: 'Upstream connection failed' },
      });
    });

    res.on('close', () => {
      if (!upstreamReq.destroyed) {
        upstreamReq.destroy();
      }
    });

    if (method === 'GET' || method === 'HEAD') {
      upstreamReq.end();
    } else {
      req.pipe(upstreamReq);
    }

    auth.touchLastUsed(resolved.keyId, resolved.accountId);
  };
}
