import { db, getTenantDatabase, organization } from "@sim/db";
import { mcpServers } from "@sim/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { createLogger } from "@/lib/logs/console/logger";
import { getSession } from "@/lib/auth";
import { getParsedBody, withMcpAuth } from "@/lib/mcp/middleware";
import { mcpService } from "@/lib/mcp/service";
import { validateMcpServerUrl } from "@/lib/mcp/url-validator";
import {
  createMcpErrorResponse,
  createMcpSuccessResponse,
} from "@/lib/mcp/utils";

const logger = createLogger("McpServerAPI");

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
 * PATCH - Update an MCP server in the workspace (requires write or admin permission)
 */
export const PATCH = withMcpAuth<{ id: string }>("write")(
  async (
    request: NextRequest,
    { userId, workspaceId, requestId },
    { params }
  ) => {
    const { id: serverId } = await params;

    try {
      const body = getParsedBody(request) || (await request.json());

      logger.info(
        `[${requestId}] Updating MCP server: ${serverId} in workspace: ${workspaceId}`,
        {
          userId,
          updates: Object.keys(body).filter((k) => k !== "workspaceId"),
        }
      );

      // Validate URL if being updated
      if (
        body.url &&
        (body.transport === "http" ||
          body.transport === "sse" ||
          body.transport === "streamable-http")
      ) {
        const urlValidation = validateMcpServerUrl(body.url);
        if (!urlValidation.isValid) {
          return createMcpErrorResponse(
            new Error(`Invalid MCP server URL: ${urlValidation.error}`),
            "Invalid server URL",
            400
          );
        }
        body.url = urlValidation.normalizedUrl;
      }

      // Remove workspaceId from body to prevent it from being updated
      const { workspaceId: _, ...updateData } = body;

      // Get tenant database
      const tenantDb = await getTenantDbFromSession();
      const dbToUse = tenantDb || db;

      // Get the current server to check if URL is changing
      const [currentServer] = await dbToUse
        .select({ url: mcpServers.url })
        .from(mcpServers)
        .where(
          and(
            eq(mcpServers.id, serverId),
            eq(mcpServers.workspaceId, workspaceId),
            isNull(mcpServers.deletedAt)
          )
        )
        .limit(1);

      const [updatedServer] = await dbToUse
        .update(mcpServers)
        .set({
          ...updateData,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mcpServers.id, serverId),
            eq(mcpServers.workspaceId, workspaceId),
            isNull(mcpServers.deletedAt)
          )
        )
        .returning();

      if (!updatedServer) {
        return createMcpErrorResponse(
          new Error("Server not found or access denied"),
          "Server not found",
          404
        );
      }

      // Only clear cache if URL changed (requires re-discovery)
      const urlChanged = body.url && currentServer?.url !== body.url;
      if (urlChanged) {
        await mcpService.clearCache(workspaceId);
        logger.info(`[${requestId}] Cleared cache due to URL change`);
      }

      logger.info(
        `[${requestId}] Successfully updated MCP server: ${serverId}`
      );
      return createMcpSuccessResponse({ server: updatedServer });
    } catch (error) {
      logger.error(`[${requestId}] Error updating MCP server:`, error);
      return createMcpErrorResponse(
        error instanceof Error
          ? error
          : new Error("Failed to update MCP server"),
        "Failed to update MCP server",
        500
      );
    }
  }
);
