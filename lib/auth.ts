
import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "trading_dashboard_session";
const SESSION_DURATION_SECONDS = 30 * 24 * 60 * 60;

function sign(value: string) {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    throw new Error("SESSION_SECRET is not configured");
  }

  return createHmac("sha256", secret)
    .update(value)
    .digest("hex");
}

export function createSession() {
  const expires = Date.now() + SESSION_DURATION_SECONDS * 1000;
  const payload = String(expires);

  return `${payload}.${sign(payload)}`;
}

export function verifySession(token?: string) {
  if (!token || !process.env.SESSION_SECRET) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;

  const [expires, signature] = parts;

  if (!expires || !signature || !/^\d+$/.test(expires)) {
    return false;
  }

  if (Number(expires) <= Date.now()) return false;

  const expected = sign(expires);

  const actualBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isAuthenticated(request: NextRequest) {
  return verifySession(
    request.cookies.get(COOKIE_NAME)?.value
  );
}

export function setSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, createSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_DURATION_SECONDS,
  });

  return response;
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });

  return response;
}
