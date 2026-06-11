import { NextResponse } from "next/server";
import { listRequestLogSessions } from "open-sse/utils/requestLogger.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit") || 50), 200);
  const data = await listRequestLogSessions(limit);
  return NextResponse.json(data);
}
