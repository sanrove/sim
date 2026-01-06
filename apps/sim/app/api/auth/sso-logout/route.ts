import { NextRequest, NextResponse } from "next/server";
import { db as masterDb, session } from "@sim/db";
import { eq } from "drizzle-orm";
import { createLogger } from "@/lib/logs/console/logger";
import crypto from "crypto";

const logger = createLogger("SSOLogout");

/**
 * SSO Logout API
 * Called when Ethana (ModelFlow) redirects the user to logout from Agent Builder.
 * This is a browser-redirect based logout that clears the session and redirects back.
 */
export async function GET(request: NextRequest) {
  try {
    const ethanaUrl = process.env.NEXT_PUBLIC_ETHANA_URL || "http://localhost:3000";
    const returnUrl = request.nextUrl.searchParams.get("returnUrl") || ethanaUrl;
    
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
        
        logger.info("Session deleted via SSO logout");
      } catch (dbError) {
        logger.error("Error deleting session in SSO logout", { error: dbError });
      }
    }

    // Validate returnUrl to prevent open redirect
    let safeReturnUrl = ethanaUrl;
    try {
      const returnUrlObj = new URL(returnUrl);
      const ethanaUrlObj = new URL(ethanaUrl);
      
      // Only allow redirects to the same origin as Ethana or to the Ethana URL itself
      if (returnUrlObj.origin === ethanaUrlObj.origin) {
        safeReturnUrl = returnUrl;
      }
    } catch {
      // Invalid URL, use default
      safeReturnUrl = ethanaUrl;
    }

    // Create response that redirects to the return URL (Ethana)
    const response = NextResponse.redirect(new URL(safeReturnUrl));

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
    logger.error("SSO logout error", {
      error: error.message,
      stack: error.stack,
    });
    
    // Redirect to Ethana login even on error
    const ethanaUrl = process.env.NEXT_PUBLIC_ETHANA_URL || "http://localhost:3000";
    const response = NextResponse.redirect(new URL("/login", ethanaUrl));
    
    // Clear the session cookie even on error
    response.cookies.set("better-auth.session_token", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
    
    return response;
  }
}
