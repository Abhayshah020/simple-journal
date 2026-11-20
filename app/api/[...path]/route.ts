import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated, setSessionCookie } from "../../../lib/auth";
import { sql } from "../../../lib/db";
import { createDownloadUrl, createUploadUrl } from "../../../lib/storage";
import { randomUUID } from "crypto";


export const runtime = "nodejs";

const json = (data: unknown, status = 200) =>
    NextResponse.json(data, { status });

const error = (message: string, status = 400) =>
    json({ error: message }, status);

function validOrigin(request: NextRequest) {
    const origin = request.headers.get("origin");
    if (!origin) return true;

    return origin === request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
    if (!isAuthenticated(request)) return error("Unauthorized", 401);

    const path = request.nextUrl.pathname.replace(/^\/api\/?/, "");

    try {
        if (path === "strategies") {
            const rows = await sql`
        SELECT
          s.*,
          COUNT(t.id)::int AS trade_count,
          COALESCE(SUM(t.net_pnl), 0)::numeric AS total_pnl,
          COUNT(t.id) FILTER (WHERE t.outcome = 'WIN')::int AS wins,
          COUNT(t.id) FILTER (WHERE t.outcome = 'LOSS')::int AS losses
        FROM strategies s
        LEFT JOIN trades t ON t.strategy_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC
      `;

            return json(rows);
        }

        if (path === "trades") {
            const strategyId = request.nextUrl.searchParams.get("strategyId");

            const rows = strategyId
                ? await sql`
            SELECT * FROM trades
            WHERE strategy_id = ${strategyId}
            ORDER BY traded_at DESC
          `
                : await sql`
            SELECT * FROM trades
            ORDER BY traded_at DESC
          `;

            return json(rows);
        }

        if (path === "simulation-data") {
            const strategyId = request.nextUrl.searchParams.get("strategyId");
            if (!strategyId) return error("strategyId is required");

            const rows = await sql`
        SELECT
          id, currency_pair, outcome, net_pnl,
          risk_amount, risk_percent, r_multiple, traded_at
        FROM trades
        WHERE strategy_id = ${strategyId}
        ORDER BY traded_at ASC
      `;

            return json(rows);
        }

        if (path === "screenshot-url") {
            const key = request.nextUrl.searchParams.get("key");
            if (!key || !key.startsWith("trades/")) {
                return error("Invalid screenshot key");
            }

            const rows = await sql`
        SELECT id FROM trades
        WHERE screenshot_before_key = ${key}
           OR screenshot_after_key = ${key}
        LIMIT 1
      `;

            if (!rows.length) return error("Screenshot not found", 404);

            return json({ url: await createDownloadUrl(key) });
        }

        return error("Not found", 404);
    } catch (e) {
        console.error(e);
        return error("Server error", 500);
    }
}

export async function POST(request: NextRequest) {
    if (!validOrigin(request)) return error("Invalid origin", 403);

    const path = request.nextUrl.pathname.replace(/^\/api\/?/, "");

    try {
        if (path === "login") {
            const body = await request.json();

            if (
                !process.env.DASHBOARD_PASSWORD ||
                body.password !== process.env.DASHBOARD_PASSWORD
            ) {
                return error("Incorrect password", 401);
            }

            return setSessionCookie(json({ success: true }));
        }

        if (!isAuthenticated(request)) return error("Unauthorized", 401);

        const body = await request.json();

        if (path === "strategies") {
            const title = String(body.title || "").trim();
            const description = String(body.description || "").trim();
            const initialBalance = Number(body.initialBalance);

            if (!title || title.length > 120) {
                return error("Strategy title is required (max 120 characters)");
            }

            if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
                return error("Initial balance must be greater than zero");
            }

            const rows = await sql`
        INSERT INTO strategies (title, description, initial_balance)
        VALUES (${title}, ${description}, ${initialBalance})
        RETURNING *
      `;

            return json(rows[0], 201);
        }

        if (path === "trades") {
            const strategyId = String(body.strategyId || "");
            const pair = String(body.currencyPair || "").trim().toUpperCase();
            const outcome = body.outcome;
            const amount = Number(body.amount);
            const commission = Number(body.commission || 0);
            const swap = Number(body.swap || 0);

            if (!strategyId || !pair) return error("Strategy and pair are required");
            if (!["WIN", "LOSS"].includes(outcome)) return error("Invalid outcome");
            if (!Number.isFinite(amount) || amount <= 0) {
                return error("Trade amount must be greater than zero");
            }
            if (!Number.isFinite(commission) || !Number.isFinite(swap)) {
                return error("Invalid commission or swap");
            }

            const netPnl = outcome === "WIN" ? amount : -amount;

            const strategies = await sql`
        SELECT id FROM strategies WHERE id = ${strategyId}
      `;
            if (!strategies.length) return error("Strategy not found", 404);

            const beforeKey = body.screenshotBeforeKey || null;
            const afterKey = body.screenshotAfterKey || null;

            const rows = await sql`
        INSERT INTO trades (
          strategy_id, currency_pair, outcome, net_pnl,
          commission, swap, session,
          risk_amount, risk_percent, r_multiple,
          screenshot_before_key, screenshot_after_key,
          notes, traded_at
        )
        VALUES (
          ${strategyId}, ${pair}, ${outcome}, ${netPnl},
          ${commission}, ${swap}, ${body.session || null},
          ${body.riskAmount ? Number(body.riskAmount) : null},
          ${body.riskPercent ? Number(body.riskPercent) : null},
          ${body.rMultiple ? Number(body.rMultiple) : null},
          ${beforeKey}, ${afterKey},
          ${body.notes || null},
          ${body.tradedAt ? new Date(body.tradedAt) : new Date()}
        )
        RETURNING *
      `;

            return json(rows[0], 201);
        }

        if (path === "upload-url") {
            const contentType = String(body.contentType || "");
            const allowed = ["image/jpeg", "image/png", "image/webp"];

            if (!allowed.includes(contentType)) {
                return error("Only JPEG, PNG, and WebP screenshots are allowed");
            }

            const key = `trades/${randomUUID()}.${contentType.split("/")[1]}`;
            const url = await createUploadUrl(key, contentType);

            return json({ key, url });
        }

        return error("Not found", 404);
    } catch (e) {
        console.error(e);
        return error("Server error", 500);
    }
}

export async function DELETE(request: NextRequest) {
    if (!isAuthenticated(request)) return error("Unauthorized", 401);
    if (!validOrigin(request)) return error("Invalid origin", 403);

    const path = request.nextUrl.pathname.replace(/^\/api\/?/, "");
    const id = request.nextUrl.searchParams.get("id");

    if (path !== "trades" || !id) return error("Invalid request");

    try {
        const rows = await sql`
      DELETE FROM trades WHERE id = ${id} RETURNING id
    `;

        if (!rows.length) return error("Trade not found", 404);
        return json({ success: true });
    } catch (e) {
        console.error(e);
        return error("Could not delete trade", 500);
    }
}