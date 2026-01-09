import { db, organization } from "@sim/db";
import { workflow } from "@sim/db/schema";
import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import {
  authenticateApiKeyFromHeader,
  updateApiKeyLastUsed,
} from "@/lib/api-key/service";
import { getSession } from "@/lib/auth";
import { verifyInternalToken } from "@/lib/auth/internal";
import { createLogger } from "@/lib/logs/console/logger";

const logger = createLogger("HybridAuth");

export interface AuthResult {
  success: boolean;
  userId?: string;
  authType?: "session" | "api_key" | "internal_jwt";
  error?: string;
  organizationId?: string; // Active organization ID for tenant resolution
  tenantId?: string; // Resolved tenant ID if available
}

/**
 * Check for authentication using any of the 3 supported methods:
 * 1. Session authentication (cookies)
 * 2. API key authentication (X-API-Key header)
 * 3. Internal JWT authentication (Authorization: Bearer header)
 *
 * For internal JWT calls, requires workflowId to determine user context
 */
export async function checkHybridAuth(
  request: NextRequest,
  options: { requireWorkflowId?: boolean } = {}
): Promise<AuthResult> {
  try {
    // 1. Check for internal JWT token first
    const authHeader = request.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];
      const verification = await verifyInternalToken(token);
      const session = await getSession();
      logger.info("Monish Session", session);
      const orgId = (session as any)?.session?.activeOrganizationId;
      let tenantId = "";
      if (orgId) {
      }

      const orgRecord = await db.query.organization.findFirst({
        where: eq(organization.id, orgId),
      });

      if (orgRecord?.name?.startsWith("ModelFlow-"))
        tenantId = orgRecord.name.replace("ModelFlow-", "");

      if (verification.valid) {
        let workflowId: string | null = null;
        let userId: string | null = verification.userId || null;
        let workspaceId: string | null = null;

        const { searchParams } = new URL(request.url);
        workflowId = searchParams.get("workflowId");
        workspaceId = searchParams.get("workspaceId");
        if (!userId) {
          userId = searchParams.get("userId");
        }

        // Parse request body once and extract all needed values
        let body: any = null;
        let requestTenantId: string | undefined;

        if (
          !workflowId &&
          !userId &&
          !workspaceId &&
          request.method === "POST"
        ) {
          try {
            // Clone the request to avoid consuming the original body
            const clonedRequest = request.clone();
            const bodyText = await clonedRequest.text();
            if (bodyText) {
              body = JSON.parse(bodyText);
              workflowId = body.workflowId || body._context?.workflowId;
              userId = userId || body.userId || body._context?.userId;
              workspaceId =
                workspaceId || body.workspaceId || body._context?.workspaceId;
              requestTenantId = tenantId;
            }
          } catch {
            // Ignore JSON parse errors
          }
        }

        logger.info("[Internal JWT] Decoded token data:", {
          hasUserId: !!userId,
          hasWorkflowId: !!workflowId,
          hasWorkspaceId: !!workspaceId,
          hasTenantId: !!tenantId,
          userId: userId || "none",
          workflowId: workflowId || "none",
          workspaceId: workspaceId || "none",
          tenantId: tenantId || "none",
        });

        if (userId) {
          // Resolve tenant info if workspaceId is available
          let tenantId: string | undefined;
          if (workspaceId) {
            try {
              // Look up workspace to get its organization
              const { workspace: workspaceSchema, member: memberSchema } =
                await import("@sim/db/schema");
              const [workspaceData] = await db
                .select({
                  ownerId: workspaceSchema.ownerId,
                })
                .from(workspaceSchema)
                .where(eq(workspaceSchema.id, workspaceId))
                .limit(1);

              if (workspaceData?.ownerId) {
                // Get member to find organizationId
                const [memberData] = await db
                  .select({ organizationId: memberSchema.organizationId })
                  .from(memberSchema)
                  .where(eq(memberSchema.userId, workspaceData.ownerId))
                  .limit(1);

                if (memberData?.organizationId) {
                  const orgRecord = await db.query.organization.findFirst({
                    where: eq(organization.id, memberData.organizationId),
                  });
                  if (orgRecord?.name?.startsWith("ModelFlow-")) {
                    tenantId = orgRecord.name.replace("ModelFlow-", "");
                  }
                }
              }
            } catch (error) {
              logger.warn(
                "[Internal JWT] Failed to resolve tenant from workspaceId for userId:",
                {
                  workspaceId,
                  error: error instanceof Error ? error.message : String(error),
                }
              );
            }
          }

          return {
            success: true,
            userId,
            authType: "internal_jwt",
            organizationId: workspaceId || undefined,
            tenantId,
          };
        }

        if (workflowId) {
          // Try to resolve tenant from requestTenantId first, then from workspaceId if available
          let tenantDb = db;
          let tenantId: string | undefined = requestTenantId;
          let resolvedUserId: string | null = null;

          // If tenantId was provided in the request, use it directly
          if (tenantId) {
            try {
              const { getTenantDatabase } = await import("@sim/db/tenant-db");
              tenantDb = await getTenantDatabase(tenantId);
              logger.info("[Internal JWT] Using tenantId from request body:", {
                tenantId,
              });
            } catch (error) {
              logger.warn(
                "[Internal JWT] Failed to get tenant database from provided tenantId:",
                {
                  tenantId,
                  error: error instanceof Error ? error.message : String(error),
                }
              );
              tenantId = undefined;
            }
          }

          // If no tenantId provided, try to resolve from workspaceId
          if (!tenantId && workspaceId) {
            try {
              logger.info(
                "[Internal JWT] Starting workspace→tenant resolution:",
                { workspaceId }
              );

              // Look up workspace to get its organization
              const { workspace: workspaceSchema, member: memberSchema } =
                await import("@sim/db/schema");
              const [workspaceData] = await db
                .select({
                  ownerId: workspaceSchema.ownerId,
                })
                .from(workspaceSchema)
                .where(eq(workspaceSchema.id, workspaceId))
                .limit(1);

              logger.info("[Internal JWT] Workspace query result:", {
                found: !!workspaceData,
                ownerId: workspaceData?.ownerId,
              });

              if (workspaceData?.ownerId) {
                // Get member to find organizationId
                const [memberData] = await db
                  .select({ organizationId: memberSchema.organizationId })
                  .from(memberSchema)
                  .where(eq(memberSchema.userId, workspaceData.ownerId))
                  .limit(1);

                logger.info("[Internal JWT] Member query result:", {
                  found: !!memberData,
                  organizationId: memberData?.organizationId,
                });

                if (memberData?.organizationId) {
                  const orgRecord = await db.query.organization.findFirst({
                    where: eq(organization.id, memberData.organizationId),
                  });

                  logger.info("[Internal JWT] Organization query result:", {
                    found: !!orgRecord,
                    name: orgRecord?.name,
                    startsWithModelFlow:
                      orgRecord?.name?.startsWith("ModelFlow-"),
                  });

                  if (orgRecord?.name?.startsWith("ModelFlow-")) {
                    tenantId = orgRecord.name.replace("ModelFlow-", "");
                    const { getTenantDatabase } = await import(
                      "@sim/db/tenant-db"
                    );
                    tenantDb = await getTenantDatabase(tenantId);
                    logger.info(
                      "[Internal JWT] Resolved tenant from workspaceId:",
                      {
                        workspaceId,
                        tenantId,
                      }
                    );
                  }
                }
              }
            } catch (error) {
              logger.warn(
                "[Internal JWT] Failed to resolve tenant from workspaceId:",
                {
                  workspaceId,
                  error: error instanceof Error ? error.message : String(error),
                }
              );
              // Fall back to default db
            }
          }

          logger.info("[Internal JWT] About to query workflow:", {
            workflowId,
            workspaceId,
            tenantId,
            usingTenantDb: tenantDb !== db,
          });

          try {
            const [workflowData] = await tenantDb
              .select({ userId: workflow.userId })
              .from(workflow)
              .where(eq(workflow.id, workflowId))
              .limit(1);

            logger.info("[Internal JWT] Workflow query result:", {
              workflowId,
              found: !!workflowData,
              userId: workflowData?.userId,
            });

            if (workflowData) {
              resolvedUserId = workflowData.userId;
            }
          } catch (error) {
            logger.warn("[Internal JWT] Failed to lookup workflow:", {
              workflowId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          // If workflow not found (e.g., draft workflow), check if userId is in JWT
          if (!resolvedUserId && verification.userId) {
            resolvedUserId = verification.userId;
            logger.info(
              "[Internal JWT] Using userId from JWT token for draft workflow:",
              {
                workflowId,
                userId: resolvedUserId,
              }
            );
          }

          if (!resolvedUserId) {
            return {
              success: false,
              error: "Workflow not found",
            };
          }

          return {
            success: true,
            userId: resolvedUserId,
            authType: "internal_jwt",
            organizationId: workspaceId || undefined,
            tenantId,
          };
        }

        if (options.requireWorkflowId !== false) {
          return {
            success: false,
            error: "workflowId or userId required for internal JWT calls",
          };
        }

        return {
          success: true,
          authType: "internal_jwt",
        };
      }
    }

    // 2. Try session auth (for web UI)
    const session = await getSession();
    if (session?.user?.id) {
      let organizationId: string | undefined;
      let tenantId: string | undefined;

      // Extract organization ID from session (from custom session plugin)
      const activeOrgId = (session as any)?.session?.activeOrganizationId;

      if (activeOrgId) {
        organizationId = activeOrgId;

        // Try to resolve tenant ID from organization
        try {
          const orgRecord = await db.query.organization.findFirst({
            where: eq(organization.id, activeOrgId),
          });

          if (orgRecord?.name?.startsWith("ModelFlow-")) {
            tenantId = orgRecord.name.replace("ModelFlow-", "");
          }
        } catch (error) {
          logger.warn(
            "Failed to resolve tenant from organization in session auth:",
            error
          );
        }
      }

      return {
        success: true,
        userId: session.user.id,
        authType: "session",
        organizationId,
        tenantId,
      };
    }

    // 3. Try API key auth
    const apiKeyHeader = request.headers.get("x-api-key");
    if (apiKeyHeader) {
      const result = await authenticateApiKeyFromHeader(apiKeyHeader);
      if (result.success) {
        await updateApiKeyLastUsed(result.keyId!);

        let organizationId: string | undefined;
        let tenantId: string | undefined;

        // Resolve organization and tenant from user's active organization
        try {
          const { session } = await import("@sim/db/schema");
          const [userSession] = await db
            .select({ activeOrganizationId: session.activeOrganizationId })
            .from(session)
            .where(eq(session.userId, result.userId!))
            .orderBy(desc(session.createdAt))
            .limit(1);

          if (userSession?.activeOrganizationId) {
            organizationId = userSession.activeOrganizationId;

            const orgRecord = await db.query.organization.findFirst({
              where: eq(organization.id, organizationId),
            });

            if (orgRecord?.name?.startsWith("ModelFlow-")) {
              tenantId = orgRecord.name.replace("ModelFlow-", "");
              logger.info("[API Key Auth] Resolved tenant from user session:", {
                userId: result.userId,
                organizationId,
                tenantId,
              });
            }
          }
        } catch (error) {
          logger.warn("Failed to resolve tenant from API key user:", error);
        }

        return {
          success: true,
          userId: result.userId!,
          authType: "api_key",
          organizationId,
          tenantId,
        };
      }

      return {
        success: false,
        error: "Invalid API key",
      };
    }

    // No authentication found
    return {
      success: false,
      error:
        "Authentication required - provide session, API key, or internal JWT",
    };
  } catch (error) {
    logger.error("Error in hybrid authentication:", error);
    return {
      success: false,
      error: "Authentication error",
    };
  }
}
