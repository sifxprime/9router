import { NextResponse } from "next/server";
import { CursorService } from "@/lib/oauth/services/cursor";
import { createProviderConnection, getProviderConnectionById, updateProviderConnection } from "@/models";
import { autoSetupMitmForProvider } from "@/lib/mitm/autoSetupForProvider";

/**
 * POST /api/oauth/cursor/import
 * Import and validate access token from Cursor IDE's local SQLite database
 *
 * Request body:
 * - accessToken: string - Access token from cursorAuth/accessToken
 * - machineId: string - Machine ID from storage.serviceMachineId
 */
export async function POST(request) {
  try {
    const { accessToken, machineId, existingConnectionId } = await request.json();

    if (!accessToken || typeof accessToken !== "string") {
      return NextResponse.json(
        { error: "Access token is required" },
        { status: 400 }
      );
    }

    if (!machineId || typeof machineId !== "string") {
      return NextResponse.json(
        { error: "Machine ID is required" },
        { status: 400 }
      );
    }

    const cursorService = new CursorService();

    // Validate token by making API call
    const tokenData = await cursorService.validateImportToken(
      accessToken.trim(),
      machineId.trim()
    );

    // Try to extract user info from token
    const userInfo = cursorService.extractUserInfo(tokenData.accessToken);

    const connectionPayload = {
      provider: "cursor",
      authType: "oauth",
      accessToken: tokenData.accessToken,
      refreshToken: null,
      expiresAt: new Date(Date.now() + tokenData.expiresIn * 1000).toISOString(),
      email: userInfo?.email || null,
      providerSpecificData: {
        machineId: tokenData.machineId,
        authMethod: "imported",
        provider: "Imported",
        userId: userInfo?.userId,
      },
      testStatus: "active",
      lastError: null,
      lastErrorAt: null,
      isActive: true,
    };

    let connection;
    if (existingConnectionId) {
      const existing = await getProviderConnectionById(existingConnectionId);
      if (!existing || existing.provider !== "cursor") {
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

    const mitm = await autoSetupMitmForProvider("cursor");

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
    console.error("Cursor import token error:", error?.message);
    return NextResponse.json({ error: "Failed to import token" }, { status: 500 });
  }
}

/**
 * GET /api/oauth/cursor/import
 * Get instructions for importing Cursor token
 */
export async function GET() {
  const cursorService = new CursorService();
  const instructions = cursorService.getTokenStorageInstructions();

  return NextResponse.json({
    provider: "cursor",
    method: "import_token",
    instructions,
    requiredFields: [
      {
        name: "accessToken",
        label: "Access Token",
        description: "From cursorAuth/accessToken in state.vscdb",
        type: "textarea",
      },
      {
        name: "machineId",
        label: "Machine ID",
        description: "From storage.serviceMachineId in state.vscdb",
        type: "text",
      },
    ],
  });
}
