import { NextRequest, NextResponse } from "next/server";
import { db as masterDb, session } from "@sim/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@/lib/logs/console/logger";
import crypto from "crypto";

const logger = createLogger("CrossAppLogout");

/**
 * Cross-App Logout API
 * Called by Ethana (ModelFlow) when a user logs out from the main application.
 * This endpoint invalidates the Agent Builder session for the user.
 */
export async function POST(request: NextRequest) {
  try {
    // Verify shared secret for security
    const sharedSecret = process.env.MODELFLOW_SIM_SHARED_SECRET;
    if (!sharedSecret) {
      logger.error("MODELFLOW_SIM_SHARED_SECRET is not configured");
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 }
      );
    }

    // Get authorization header
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.warn("Missing or invalid authorization header");
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    const providedSecret = authHeader.replace("Bearer ", "");
    if (providedSecret !== sharedSecret) {
      logger.warn("Invalid shared secret provided");
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Get user email from request body
    const body = await request.json();
    const { email, userId, tenantId } = body;

    if (!email && !userId) {
      logger.warn("No email or userId provided in cross-app logout request");
      return NextResponse.json(
        { error: "Email or userId is required" },
        { status: 400 }
      );
    }

    logger.info("Processing cross-app logout request", {
      email,
      userId,
      tenantId,
    });

    // Find and delete sessions for this user
    // We need to find the user by email first, then delete their sessions
    if (userId) {
      try {
        await masterDb
          .delete(session)
          .where(eq(session.userId, userId));
        
        logger.info("Deleted sessions for user", {
          userId,
        });
      } catch (dbError) {
        logger.error("Error deleting sessions", { error: dbError });
        // Continue even if deletion fails - the session will expire eventually
      }
    }

    return NextResponse.json({
      success: true,
      message: "Cross-app logout successful",
    });
  } catch (error: any) {
    logger.error("Cross-app logout error", {
      error: error.message,
      stack: error.stack,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * GET handler for cross-app logout (redirect-based)
 * Called when Ethana redirects the browser to log out the Agent Builder session
 */
export async function GET(request: NextRequest) {
  try {
    const ethanaUrl = process.env.NEXT_PUBLIC_ETHANA_URL || "http://localhost:3000";
    
    // Get the session cookie
    const sessionCookie = request.cookies.get("better-auth.session_token");
    
    if (sessionCookie?.value) {
      // Hash the token to match what's stored in DB
      const sessionTokenHash = crypto
        .createHash("sha256")
        .update(sessionCookie.value)
        .digest("hex");

      try {
        // Delete the session from database
        await masterDb
          .delete(session)
          .where(eq(session.token, sessionTokenHash));
        
        logger.info("Session deleted via GET cross-app logout");
      } catch (dbError) {
        logger.error("Error deleting session in GET handler", { error: dbError });
      }
    }

    // Create response that redirects to Ethana
    const response = NextResponse.redirect(new URL("/login", ethanaUrl));

    // Clear the session cookie
    response.cookies.set("better-auth.session_token", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });

    return response;
  } catch (error: any) {
    logger.error("Cross-app logout GET error", {
      error: error.message,
      stack: error.stack,
    });
    
    // Redirect to Ethana login even on error
    const ethanaUrl = process.env.NEXT_PUBLIC_ETHANA_URL || "http://localhost:3000";
    return NextResponse.redirect(new URL("/login", ethanaUrl));
  }
}
