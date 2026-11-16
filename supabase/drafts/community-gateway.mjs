import { createServer } from 'node:http';
import {
  consentPath, createCommunityPriceHandler, maxBodyBytes, searchPath
} from './community-price-transport.mjs';
import { createSupabaseReceiptConsentHandler } from './supabase-receipt-consent.mjs';

function sendError(response, status, error, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Connection': 'close',
    ...headers
  });
  response.end(JSON.stringify({ error }));
}

async function collectBody(request) {
  if (Number(request.headers['content-length']) > maxBodyBytes) return null;
  const chunks = [];
  let size = 0;
  // Leave the socket open long enough to return 413 before closing it.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > maxBodyBytes) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

// An isolated Node gateway. The public static build does not load this module.
export function createCommunityGateway({ origin, auth, database, lookup, servePage }) {
  const canonical = new URL(origin);
  const routes = new Map([
    [consentPath, createSupabaseReceiptConsentHandler({ auth, database })],
    [searchPath, createCommunityPriceHandler(lookup)]
  ]);

  return createServer({ maxHeaderSize: 8192, headersTimeout: 10000, requestTimeout: 15000, connectionsCheckingInterval: 1000 },
    async (request, response) => {
      try {
        const url = new URL(request.url, canonical);
        const requestOrigin = request.headers.origin;
        if (request.headers.host?.toLowerCase() !== canonical.host || url.origin !== canonical.origin
          || (requestOrigin && requestOrigin !== canonical.origin)) {
          sendError(response, 403, 'Request origin is not allowed.');
          return;
        }
        const handler = routes.get(url.pathname);
        if (!handler) {
          if (servePage?.(request, response, url.pathname)) return;
          sendError(response, 404, 'Not found.');
          return;
        }
        if (request.method !== 'POST') {
          sendError(response, 405, 'Use POST.', { Allow: 'POST' });
          return;
        }
        const body = await collectBody(request);
        if (body === null) {
          sendError(response, 413, 'Request is too large.');
          return;
        }
        const headers = new Headers();
        if (request.headers['content-type']) headers.set('Content-Type', request.headers['content-type']);
        if (url.pathname === consentPath && request.headers.authorization) {
          headers.set('Authorization', request.headers.authorization);
        }
        const result = await handler(new Request(url, { method: 'POST', headers, body }));
        const payload = Buffer.from(await result.arrayBuffer());
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(payload);
      } catch {
        if (!response.headersSent && !response.destroyed) {
          sendError(response, 503, 'Could not complete the request. Try again.');
        } else if (!response.writableEnded) {
          response.destroy();
        }
      }
    });
}
