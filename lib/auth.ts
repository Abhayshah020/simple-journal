import { createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "trading_dashboard_session";

function sign(value: string) {
  return createHmac("sha256", process.env.SESSION_SECRET!)
    .update(value)
    .digest("hex");
}

export function createSession() {
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const payload = String(expires);
  return `${payload}.${sign(payload)}`;
}

export function verifySession(token?: string) {
  if (!token || !process.env.SESSION_SECRET) return false;

  const [expires, signature] = token.split(".");
  if (!expires || !signature || Number(expires) < Date.now()) return false;

  const expected = sign(expires);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
}

export function isAuthenticated(request: NextRequest) {
  return verifySession(request.cookies.get(COOKIE_NAME)?.value);
}

export function setSessionCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, createSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });

  return response;
}