import { db, getTenantDatabase, organization } from "@sim/db";
import { mcpServers } from "@sim/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { createLogger } from "@/lib/logs/console/logger";
import { getSession } from "@/lib/auth";
import { withMcpAuth } from "@/lib/mcp/middleware";
import { mcpService } from "@/lib/mcp/service";
import type { McpServerStatusConfig } from "@/lib/mcp/types";
import {
  createMcpErrorResponse,
  createMcpSuccessResponse,
} from "@/lib/mcp/utils";

const logger = createLogger("McpServerRefreshAPI");

export const dynamic = "force-dynamic";

/**
 * Helper to get tenant database from session
 */
async function getTenantDbFromSession() {
  try {
    const session = (await getSession()) as any;
    const orgId = session?.session?.activeOrganizationId;
    if (!orgId) return null;

    const orgRecord = await db.query.organization.findFirst({
      where: eq(organization.id, orgId),
    });

    if (!orgRecord?.name?.startsWith("ModelFlow-")) return null;

    const tenantId = orgRecord.name.replace("ModelFlow-", "");
    return getTenantDatabase(tenantId);
  } catch (error) {
    logger.error("Error getting tenant database from session:", error);
    return null;
  }
}

/**
 * POST - Refresh an MCP server connection (requires any workspace permission)
 */
export const POST = withMcpAuth<{ id: string }>("read")(
  async (
    request: NextRequest,
    { userId, workspaceId, requestId },
    { params }
  ) => {
    const { id: serverId } = await params;

    try {
      logger.info(
        `[${requestId}] Refreshing MCP server: ${serverId} in workspace: ${workspaceId}`,
        {
          userId,
        }
      );

      // Get tenant database
      const tenantDb = await getTenantDbFromSession();
      const dbToUse = tenantDb || db;

      const [server] = await dbToUse
        .select()
        .from(mcpServers)
        .where(
          and(
            eq(mcpServers.id, serverId),
            eq(mcpServers.workspaceId, workspaceId),
            isNull(mcpServers.deletedAt)
          )
        )
        .limit(1);

      if (!server) {
        return createMcpErrorResponse(
          new Error("Server not found or access denied"),
          "Server not found",
          404
        );
      }

      let connectionStatus: "connected" | "disconnected" | "error" = "error";
      let toolCount = 0;
      let lastError: string | null = null;

      const currentStatusConfig: McpServerStatusConfig =
        (server.statusConfig as McpServerStatusConfig | null) ?? {
          consecutiveFailures: 0,
          lastSuccessfulDiscovery: null,
        };

      try {
        const tools = await mcpService.discoverServerTools(
          userId,
          serverId,
          workspaceId
        );
        connectionStatus = "connected";
        toolCount = tools.length;
        logger.info(
          `[${requestId}] Successfully connected to server ${serverId}, discovered ${toolCount} tools`
        );
      } catch (error) {
        connectionStatus = "error";
        lastError =
          error instanceof Error ? error.message : "Connection test failed";
        logger.warn(
          `[${requestId}] Failed to connect to server ${serverId}:`,
          error
        );
      }

      const now = new Date();
      const newStatusConfig =
        connectionStatus === "connected"
          ? {
              consecutiveFailures: 0,
              lastSuccessfulDiscovery: now.toISOString(),
            }
          : {
              consecutiveFailures: currentStatusConfig.consecutiveFailures + 1,
              lastSuccessfulDiscovery:
                currentStatusConfig.lastSuccessfulDiscovery,
            };

      const [refreshedServer] = await dbToUse
        .update(mcpServers)
        .set({
          lastToolsRefresh: now,
          connectionStatus,
          lastError,
          lastConnected:
            connectionStatus === "connected" ? now : server.lastConnected,
          toolCount,
          statusConfig: newStatusConfig,
          updatedAt: now,
        })
        .where(eq(mcpServers.id, serverId))
        .returning();

      if (connectionStatus === "connected") {
        logger.info(
          `[${requestId}] Successfully refreshed MCP server: ${serverId} (${toolCount} tools)`
        );
        await mcpService.clearCache(workspaceId);
      } else {
        logger.warn(
          `[${requestId}] Refresh completed for MCP server ${serverId} but connection failed: ${lastError}`
        );
      }

      return createMcpSuccessResponse({
        status: connectionStatus,
        toolCount,
        lastConnected: refreshedServer?.lastConnected?.toISOString() || null,
        error: lastError,
      });
    } catch (error) {
      logger.error(`[${requestId}] Error refreshing MCP server:`, error);
      return createMcpErrorResponse(
        error instanceof Error
          ? error
          : new Error("Failed to refresh MCP server"),
        "Failed to refresh MCP server",
        500
      );
    }
  }
);
