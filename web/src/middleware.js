import { NextResponse } from 'next/server';
import { jwtVerify } from 'jose/jwt/verify';
import * as Sentry from '@sentry/nextjs';

// Edge-compatible JWT verification
function authSecret() {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET must be set to a random string of at least 16 characters in production.');
  }
  return 'dev-secret-change-me';
}
// Resolved on first use, not at import time, so `next build` (which loads
// route modules without runtime env) does not need the secret; the first
// request in production still fails loudly if it is missing.
let _secret;
function secret() {
  if (!_secret) _secret = new TextEncoder().encode(authSecret());
  return _secret;
}

async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload;
  } catch {
    return null;
  }
}

const COOKIE_NAME = 'gdr_session';

function getSessionToken(request) {
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

function clearCookie(response) {
  response.headers.append(
    'Set-Cookie',
    'gdr_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
  );
  return response;
}

/**
 * Check if an email is in the deactivated set via Upstash REST API (Edge-compatible)
 * or ioredis (Node runtime in dev).
 */
async function isDeactivated(email) {
  const normalized = email.trim().toLowerCase();

  // Upstash REST API (production / Edge)
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && restToken) {
    try {
      const res = await fetch(`${restUrl}/sismember/deactivated/${encodeURIComponent(normalized)}`, {
        headers: { Authorization: `Bearer ${restToken}` },
      });
      const data = await res.json();
      return data.result === 1;
    } catch {
      return false;
    }
  }

  // Local Redis via ioredis (dev)
  if (process.env.REDIS_URL) {
    try {
      const Redis = (await import('ioredis')).default;
      const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true });
      const result = await redis.sismember('deactivated', normalized);
      redis.disconnect();
      return result === 1;
    } catch {
      return false;
    }
  }

  return false;
}

const PUBLIC_PATHS = ['/', '/api/auth/request-code', '/api/auth/verify-code', '/api/auth/me', '/api/auth/logout', '/api/monitoring'];

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname === p)) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith('/_next') || pathname.startsWith('/favicon') || pathname.startsWith('/assets')) {
    return NextResponse.next();
  }

  // Check session
  const token = getSessionToken(request);
  if (!token) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const payload = await verifySession(token);
  if (!payload) {
    return clearCookie(NextResponse.redirect(new URL('/', request.url)));
  }

  // Identify user in Sentry (edge)
  if (payload.email) {
    Sentry.setUser({ id: payload.email, email: payload.email, username: payload.name || payload.email });
  }

  // Check if user is deactivated — log them out immediately
  if (payload.email && await isDeactivated(payload.email)) {
    return clearCookie(NextResponse.redirect(new URL('/', request.url)));
  }

  // Inject user info into headers for downstream use
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-user-email', payload.email);
  requestHeaders.set('x-user-name', payload.name || '');

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
