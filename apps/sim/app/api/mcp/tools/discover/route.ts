import type { NextRequest } from "next/server";
import { getTenantDatabase, organization, db } from "@sim/db";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { createLogger } from "@/lib/logs/console/logger";
import { getParsedBody, withMcpAuth } from "@/lib/mcp/middleware";
import { mcpService } from "@/lib/mcp/service";
import type { McpToolDiscoveryResponse } from "@/lib/mcp/types";
import {
  categorizeError,
  createMcpErrorResponse,
  createMcpSuccessResponse,
} from "@/lib/mcp/utils";

const logger = createLogger("McpToolDiscoveryAPI");

export const dynamic = "force-dynamic";

/**
 * GET - Discover all tools from user's MCP servers
 */
export const GET = withMcpAuth("read")(
  async (request: NextRequest, { userId, workspaceId, requestId }) => {
    try {
      const { searchParams } = new URL(request.url);
      const serverId = searchParams.get("serverId");
      const forceRefresh = searchParams.get("refresh") === "true";

      // Get tenant database - try multiple strategies
      let tenantDb: Awaited<ReturnType<typeof getTenantDatabase>> | undefined;
      try {
        // Strategy 1: Try to get from session (for direct user requests)
        const session = (await getSession()) as any;
        const orgId = session?.session?.activeOrganizationId;
        if (orgId) {
          const orgRecord = await db.query.organization.findFirst({
            where: eq(organization.id, orgId),
          });
          if (orgRecord?.name?.startsWith("ModelFlow-")) {
            const tenantId = orgRecord.name.replace("ModelFlow-", "");
            tenantDb = await getTenantDatabase(tenantId);
            logger.debug(`[${requestId}] Got tenant database from session`);
          }
        }
      } catch (error) {
        logger.debug(
          `[${requestId}] Could not get tenant database from session:`,
          error
        );
      }

      // Strategy 2: If no tenantDb yet and we have workspaceId, look up workspace to get tenant
      if (!tenantDb && workspaceId) {
        try {
          const { workspace: workspaceSchema, member: memberSchema } =
            await import("@sim/db/schema");
          const workspaceRecords = await db
            .select({ ownerId: workspaceSchema.ownerId })
            .from(workspaceSchema)
            .where(eq(workspaceSchema.id, workspaceId))
            .limit(1);

          if (workspaceRecords.length > 0 && workspaceRecords[0].ownerId) {
            // Get organization through member table
            const memberRecords = await db
              .select({ organizationId: memberSchema.organizationId })
              .from(memberSchema)
              .where(eq(memberSchema.userId, workspaceRecords[0].ownerId))
              .limit(1);

            if (memberRecords.length > 0 && memberRecords[0].organizationId) {
              const orgRecord = await db.query.organization.findFirst({
                where: eq(organization.id, memberRecords[0].organizationId),
              });

              if (orgRecord?.name?.startsWith("ModelFlow-")) {
                const tenantId = orgRecord.name.replace("ModelFlow-", "");
                tenantDb = await getTenantDatabase(tenantId);
                logger.debug(
                  `[${requestId}] Got tenant database from workspace lookup`
                );
              }
            }
          }
        } catch (error) {
          logger.debug(
            `[${requestId}] Could not get tenant database from workspace:`,
            error
          );
        }
      }

      logger.info(`[${requestId}] Discovering MCP tools for user ${userId}`, {
        serverId,
        workspaceId,
        forceRefresh,
      });

      let tools;
      if (serverId) {
        tools = await mcpService.discoverServerTools(
          userId,
          serverId,
          workspaceId,
          tenantDb
        );
      } else {
        tools = await mcpService.discoverTools(
          userId,
          workspaceId,
          forceRefresh,
          tenantDb
        );
      }

      const byServer: Record<string, number> = {};
      for (const tool of tools) {
        byServer[tool.serverId] = (byServer[tool.serverId] || 0) + 1;
      }

      const responseData: McpToolDiscoveryResponse = {
        tools,
        totalCount: tools.length,
        byServer,
      };

      logger.info(
        `[${requestId}] Discovered ${tools.length} tools from ${
          Object.keys(byServer).length
        } servers`
      );
      return createMcpSuccessResponse(responseData);
    } catch (error) {
      logger.error(`[${requestId}] Error discovering MCP tools:`, error);
      const { message, status } = categorizeError(error);
      return createMcpErrorResponse(
        new Error(message),
        "Failed to discover MCP tools",
        status
      );
    }
  }
);

/**
 * POST - Refresh tool discovery for specific servers
 */
export const POST = withMcpAuth("read")(
  async (request: NextRequest, { userId, workspaceId, requestId }) => {
    try {
      const body = getParsedBody(request) || (await request.json());
      const { serverIds } = body;

      // Get tenant database - try multiple strategies
      let tenantDb: Awaited<ReturnType<typeof getTenantDatabase>> | undefined;
      try {
        // Strategy 1: Try to get from session (for direct user requests)
        const session = (await getSession()) as any;
        const orgId = session?.session?.activeOrganizationId;
        if (orgId) {
          const orgRecord = await db.query.organization.findFirst({
            where: eq(organization.id, orgId),
          });
          if (orgRecord?.name?.startsWith("ModelFlow-")) {
            const tenantId = orgRecord.name.replace("ModelFlow-", "");
            tenantDb = await getTenantDatabase(tenantId);
            logger.debug(`[${requestId}] Got tenant database from session`);
          }
        }
      } catch (error) {
        logger.debug(
          `[${requestId}] Could not get tenant database from session:`,
          error
        );
      }

      // Strategy 2: If no tenantDb yet and we have workspaceId, look up workspace to get tenant
      if (!tenantDb && workspaceId) {
        try {
          const { workspace: workspaceSchema, member: memberSchema } =
            await import("@sim/db/schema");
          const workspaceRecords = await db
            .select({ ownerId: workspaceSchema.ownerId })
            .from(workspaceSchema)
            .where(eq(workspaceSchema.id, workspaceId))
            .limit(1);

          if (workspaceRecords.length > 0 && workspaceRecords[0].ownerId) {
            // Get organization through member table
            const memberRecords = await db
              .select({ organizationId: memberSchema.organizationId })
              .from(memberSchema)
              .where(eq(memberSchema.userId, workspaceRecords[0].ownerId))
              .limit(1);

            if (memberRecords.length > 0 && memberRecords[0].organizationId) {
              const orgRecord = await db.query.organization.findFirst({
                where: eq(organization.id, memberRecords[0].organizationId),
              });

              if (orgRecord?.name?.startsWith("ModelFlow-")) {
                const tenantId = orgRecord.name.replace("ModelFlow-", "");
                tenantDb = await getTenantDatabase(tenantId);
                logger.debug(
                  `[${requestId}] Got tenant database from workspace lookup`
                );
              }
            }
          }
        } catch (error) {
          logger.debug(
            `[${requestId}] Could not get tenant database from workspace:`,
            error
          );
        }
      }

      if (!Array.isArray(serverIds)) {
        return createMcpErrorResponse(
          new Error("serverIds must be an array"),
          "Invalid request format",
          400
        );
      }

      logger.info(
        `[${requestId}] Refreshing tool discovery for user ${userId}, servers:`,
        serverIds
      );

      const results = await Promise.allSettled(
        serverIds.map(async (serverId: string) => {
          const tools = await mcpService.discoverServerTools(
            userId,
            serverId,
            workspaceId,
            tenantDb
          );
          return { serverId, toolCount: tools.length };
        })
      );

      const successes: Array<{ serverId: string; toolCount: number }> = [];
      const failures: Array<{ serverId: string; error: string }> = [];

      results.forEach((result, index) => {
        const serverId = serverIds[index];
        if (result.status === "fulfilled") {
          successes.push(result.value);
        } else {
          failures.push({
            serverId,
            error:
              result.reason instanceof Error
                ? result.reason.message
                : "Unknown error",
          });
        }
      });

      const responseData = {
        refreshed: successes,
        failed: failures,
        summary: {
          total: serverIds.length,
          successful: successes.length,
          failed: failures.length,
        },
      };

      logger.info(
        `[${requestId}] Tool discovery refresh completed: ${successes.length}/${serverIds.length} successful`
      );
      return createMcpSuccessResponse(responseData);
    } catch (error) {
      logger.error(`[${requestId}] Error refreshing tool discovery:`, error);
      const { message, status } = categorizeError(error);
      return createMcpErrorResponse(
        new Error(message),
        "Failed to refresh tool discovery",
        status
      );
    }
  }
);
