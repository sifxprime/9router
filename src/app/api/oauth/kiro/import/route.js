import { NextResponse } from "next/server";
import { KiroService } from "@/lib/oauth/services/kiro";
import { createProviderConnection, getProviderConnectionById, updateProviderConnection } from "@/models";
import { autoSetupMitmForProvider } from "@/lib/mitm/autoSetupForProvider";

/**
 * POST /api/oauth/kiro/import
 * Import and validate refresh token from Kiro IDE
 */
export async function POST(request) {
  try {
    const { refreshToken, existingConnectionId } = await request.json();

    if (!refreshToken || typeof refreshToken !== "string") {
      return NextResponse.json(
        { error: "Refresh token is required" },
        { status: 400 }
      );
    }

    const kiroService = new KiroService();

    // Validate and refresh token
    const tokenData = await kiroService.validateImportToken(refreshToken.trim());

    // Extract email from JWT if available
    const email = kiroService.extractEmailFromJWT(tokenData.accessToken);

    const connectionPayload = {
      provider: "kiro",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000).toISOString(),
      email: email || null,
      providerSpecificData: {
        profileArn: tokenData.profileArn,
        authMethod: "imported",
        provider: "Imported",
      },
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      isActive: true,
    };

    let connection;
    if (existingConnectionId) {
      const existing = await getProviderConnectionById(existingConnectionId);
      if (!existing || existing.provider !== "kiro") {
        return NextResponse.json({ error: "Invalid connection" }, { status: 400 });
      }
      connection = await updateProviderConnection(existingConnectionId, {
        ...connectionPayload,
        providerSpecificData: {
          ...(existing.providerSpecificData || {}),
          ...connectionPayload.providerSpecificData,
        },
      });
    } else {
      connection = await createProviderConnection(connectionPayload);
    }

    const mitm = await autoSetupMitmForProvider("kiro");

    return NextResponse.json({
      success: true,
      connection: {
        id: connection.id,
        provider: connection.provider,
        email: connection.email,
      },
      mitm,
    });
  } catch (error) {
    console.error("Kiro import token error:", error?.message);
    return NextResponse.json({ error: "Failed to import token" }, { status: 500 });
  }
}
