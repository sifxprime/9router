import { NextResponse } from "next/server";
import { getCacheStats, resetCache } from "open-sse/services/responseCache.js";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getCacheStats(), { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE() {
  resetCache();
  return NextResponse.json({ ok: true });
}
