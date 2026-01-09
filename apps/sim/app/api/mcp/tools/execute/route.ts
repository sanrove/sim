import type { NextRequest } from "next/server";
import { getTenantDatabase, organization, db } from "@sim/db";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { createLogger } from "@/lib/logs/console/logger";
import { getParsedBody, withMcpAuth } from "@/lib/mcp/middleware";
import { mcpService } from "@/lib/mcp/service";
import type { McpTool, McpToolCall, McpToolResult } from "@/lib/mcp/types";
import {
  categorizeError,
  createMcpErrorResponse,
  createMcpSuccessResponse,
  MCP_CONSTANTS,
  validateStringParam,
} from "@/lib/mcp/utils";

const logger = createLogger("McpToolExecutionAPI");

export const dynamic = "force-dynamic";

interface SchemaProperty {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  enum?: unknown[];
  format?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
}

interface ToolExecutionResult {
  success: boolean;
  output?: McpToolResult;
  error?: string;
}

function hasType(prop: unknown): prop is SchemaProperty {
  return typeof prop === "object" && prop !== null && "type" in prop;
}

/**
 * POST - Execute a tool on an MCP server
 */
export const POST = withMcpAuth("read")(
  async (request: NextRequest, { userId, workspaceId, requestId }) => {
    try {
      const body = getParsedBody(request) || (await request.json());

      // Get tenant database - try multiple strategies
      let tenantDb;
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

      // Strategy 2: If no tenantDb yet and we have workflowId, look up workflow to get tenant
      if (!tenantDb && body.workflowId) {
        try {
          const { workflow: workflowSchema } = await import("@sim/db/schema");
          const workflowRecords = await db
            .select({ workspaceId: workflowSchema.workspaceId })
            .from(workflowSchema)
            .where(eq(workflowSchema.id, body.workflowId))
            .limit(1);

          if (workflowRecords.length > 0 && workflowRecords[0].workspaceId) {
            // Get workspace to find organization
            const { workspace: workspaceSchema } = await import(
              "@sim/db/schema"
            );
            const workspaceRecords = await db
              .select({ organizationId: workspaceSchema.organizationId })
              .from(workspaceSchema)
              .where(eq(workspaceSchema.id, workflowRecords[0].workspaceId))
              .limit(1);

            if (
              workspaceRecords.length > 0 &&
              workspaceRecords[0].organizationId
            ) {
              const orgRecord = await db.query.organization.findFirst({
                where: eq(organization.id, workspaceRecords[0].organizationId),
              });

              if (orgRecord?.name?.startsWith("ModelFlow-")) {
                const tenantId = orgRecord.name.replace("ModelFlow-", "");
                tenantDb = await getTenantDatabase(tenantId);
                logger.debug(
                  `[${requestId}] Got tenant database from workflow lookup`
                );
              }
            }
          }
        } catch (error) {
          logger.debug(
            `[${requestId}] Could not get tenant database from workflow:`,
            error
          );
        }
      }

      logger.info(`[${requestId}] MCP tool execution request received`, {
        hasAuthHeader: !!request.headers.get("authorization"),
        authHeaderType: request.headers.get("authorization")?.substring(0, 10),
        bodyKeys: Object.keys(body),
        serverId: body.serverId,
        toolName: body.toolName,
        hasWorkflowId: !!body.workflowId,
        workflowId: body.workflowId,
        userId: userId,
      });

      const { serverId, toolName, arguments: rawArgs } = body;
      const args = rawArgs || {};

      const serverIdValidation = validateStringParam(serverId, "serverId");
      if (!serverIdValidation.isValid) {
        logger.warn(`[${requestId}] Invalid serverId: ${serverId}`);
        return createMcpErrorResponse(
          new Error(serverIdValidation.error),
          "Invalid serverId",
          400
        );
      }

      const toolNameValidation = validateStringParam(toolName, "toolName");
      if (!toolNameValidation.isValid) {
        logger.warn(`[${requestId}] Invalid toolName: ${toolName}`);
        return createMcpErrorResponse(
          new Error(toolNameValidation.error),
          "Invalid toolName",
          400
        );
      }

      logger.info(
        `[${requestId}] Executing tool ${toolName} on server ${serverId} for user ${userId} in workspace ${workspaceId}`
      );

      let tool: McpTool | null = null;
      try {
        if (body.toolSchema) {
          tool = {
            name: toolName,
            inputSchema: body.toolSchema,
            serverId: serverId,
            serverName: "provided-schema",
          } as McpTool;
          logger.debug(
            `[${requestId}] Using provided schema for ${toolName}, skipping discovery`
          );
        } else {
          const tools = await mcpService.discoverServerTools(
            userId,
            serverId,
            workspaceId,
            tenantDb
          );
          tool = tools.find((t) => t.name === toolName) ?? null;

          if (!tool) {
            return createMcpErrorResponse(
              new Error(
                `Tool ${toolName} not found on server ${serverId}. Available tools: ${tools
                  .map((t) => t.name)
                  .join(", ")}`
              ),
              "Tool not found",
              404
            );
          }
        }

        if (tool.inputSchema?.properties) {
          for (const [paramName, paramSchema] of Object.entries(
            tool.inputSchema.properties
          )) {
            const schema = paramSchema as any;
            const value = args[paramName];

            if (value === undefined || value === null) {
              continue;
            }

            if (
              (schema.type === "number" || schema.type === "integer") &&
              typeof value === "string"
            ) {
              const numValue =
                schema.type === "integer"
                  ? Number.parseInt(value)
                  : Number.parseFloat(value);
              if (!Number.isNaN(numValue)) {
                args[paramName] = numValue;
              }
            } else if (schema.type === "boolean" && typeof value === "string") {
              if (value.toLowerCase() === "true") {
                args[paramName] = true;
              } else if (value.toLowerCase() === "false") {
                args[paramName] = false;
              }
            } else if (schema.type === "array" && typeof value === "string") {
              const stringValue = value.trim();
              if (stringValue) {
                try {
                  const parsed = JSON.parse(stringValue);
                  if (Array.isArray(parsed)) {
                    args[paramName] = parsed;
                  } else {
                    args[paramName] = [parsed];
                  }
                } catch {
                  if (stringValue.includes(",")) {
                    args[paramName] = stringValue
                      .split(",")
                      .map((item) => item.trim())
                      .filter((item) => item);
                  } else {
                    args[paramName] = [stringValue];
                  }
                }
              } else {
                args[paramName] = [];
              }
            }
          }
        }
      } catch (error) {
        logger.warn(
          `[${requestId}] Failed to discover tools for validation, proceeding anyway:`,
          error
        );
      }

      if (tool) {
        const validationError = validateToolArguments(tool, args);
        if (validationError) {
          logger.warn(
            `[${requestId}] Tool validation failed: ${validationError}`
          );
          return createMcpErrorResponse(
            new Error(
              `Invalid arguments for tool ${toolName}: ${validationError}`
            ),
            "Invalid tool arguments",
            400
          );
        }
      }

      const toolCall: McpToolCall = {
        name: toolName,
        arguments: args,
      };

      const result = await Promise.race([
        mcpService.executeTool(
          userId,
          serverId,
          toolCall,
          workspaceId,
          tenantDb
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Tool execution timeout")),
            MCP_CONSTANTS.EXECUTION_TIMEOUT
          )
        ),
      ]);

      const transformedResult = transformToolResult(result);

      if (result.isError) {
        logger.warn(
          `[${requestId}] Tool execution returned error for ${toolName} on ${serverId}`
        );
        return createMcpErrorResponse(
          transformedResult,
          transformedResult.error || "Tool execution failed",
          400
        );
      }
      logger.info(
        `[${requestId}] Successfully executed tool ${toolName} on server ${serverId}`
      );

      try {
        const { trackPlatformEvent } = await import("@/lib/core/telemetry");
        trackPlatformEvent("platform.mcp.tool_executed", {
          "mcp.server_id": serverId,
          "mcp.tool_name": toolName,
          "mcp.execution_status": "success",
          "workspace.id": workspaceId,
        });
      } catch {
        // Telemetry failure is non-critical
      }

      return createMcpSuccessResponse(transformedResult);
    } catch (error) {
      logger.error(`[${requestId}] Error executing MCP tool:`, error);

      const { message, status } = categorizeError(error);
      return createMcpErrorResponse(new Error(message), message, status);
    }
  }
);

function validateToolArguments(
  tool: McpTool,
  args: Record<string, unknown>
): string | null {
  if (!tool.inputSchema) {
    return null;
  }

  const schema = tool.inputSchema;

  if (schema.required && Array.isArray(schema.required)) {
    for (const requiredProp of schema.required) {
      if (!(requiredProp in (args || {}))) {
        return `Missing required property: ${requiredProp}`;
      }
    }
  }

  if (schema.properties && args) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      const propValue = args[propName];
      if (propValue !== undefined && hasType(propSchema)) {
        const expectedType = propSchema.type;
        const actualType = typeof propValue;

        if (expectedType === "string" && actualType !== "string") {
          return `Property ${propName} must be a string`;
        }
        if (expectedType === "number" && actualType !== "number") {
          return `Property ${propName} must be a number`;
        }
        if (expectedType === "boolean" && actualType !== "boolean") {
          return `Property ${propName} must be a boolean`;
        }
        if (
          expectedType === "object" &&
          (actualType !== "object" ||
            propValue === null ||
            Array.isArray(propValue))
        ) {
          return `Property ${propName} must be an object`;
        }
        if (expectedType === "array" && !Array.isArray(propValue)) {
          return `Property ${propName} must be an array`;
        }
      }
    }
  }

  return null;
}

function transformToolResult(result: McpToolResult): ToolExecutionResult {
  if (result.isError) {
    return {
      success: false,
      error: result.content?.[0]?.text || "Tool execution failed",
    };
  }

  return {
    success: true,
    output: result,
  };
}
