import { SignJWT, jwtVerify } from 'jose';

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

const COOKIE_NAME = 'gdr_session';

/**
 * Create a signed JWT session token for the given email.
 * Expires in 7 days.
 */
export async function createSession(email, name) {
  return new SignJWT({ email, name: name || '' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
}

/**
 * Verify a session token. Returns the payload or null.
 */
export async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload;
  } catch {
    return null;
  }
}

/**
 * Set the session cookie on a Response.
 */
export function setSessionCookie(response, token) {
  response.headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 7}`,
  );
  return response;
}

/**
 * Clear the session cookie on a Response.
 */
export function clearSessionCookie(response) {
  response.headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
  );
  return response;
}

/**
 * Parse cookies from a Request and return the session token (if any).
 */
export function getSessionToken(request) {
  const cookies = request.headers.get('cookie') || '';
  const match = cookies.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}
