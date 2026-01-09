/**
 * Sim SSO Endpoint for ModelFlow
 * This endpoint handles the handoff token from ModelFlow
 * and creates a Sim session for the user
 *
 * File path: sim/apps/sim/app/api/auth/ethana-sso/route.ts
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@sim/db";
import { headers } from "next/headers";

// Import the validation function (you'll need to adjust the import path)
// For now, we'll implement it inline

interface ModelFlowTokenPayload {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  avatar: string | null;
  tenantId: string;
  role: string;
  isActive: boolean;
  source: string;
}

/**
 * Validate ModelFlow token
 */
function validateModelFlowToken(token: string): ModelFlowTokenPayload {
  const jwt = require("jsonwebtoken");
  const secret =
    process.env.MODELFLOW_SIM_SHARED_SECRET || process.env.JWT_SECRET || "";

  if (!secret) {
    throw new Error("MODELFLOW_SIM_SHARED_SECRET not configured");
  }

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: "ethana-api",
      audience: "agent-builder-sso",
    }) as ModelFlowTokenPayload;

    if (decoded.source !== "modelflow") {
      throw new Error("Invalid token source");
    }

    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error("Token expired");
    }
    throw new Error("Invalid token");
  }
}

export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get("token");

    if (!token) {
      return NextResponse.redirect(
        new URL("/login?error=missing_token", request.url)
      );
    }

    // Validate the token
    let modelFlowUser: ModelFlowTokenPayload;
    try {
      modelFlowUser = validateModelFlowToken(token);
    } catch (error) {
      console.error("Token validation failed:", error);
      return NextResponse.redirect(
        new URL("/login?error=invalid_token", request.url)
      );
    }

    // Check if user exists in Sim database
    let simUser = await db.user.findUnique({
      where: { email: modelFlowUser.email },
    });

    // If user doesn't exist, create them
    if (!simUser) {
      try {
        simUser = await db.user.create({
          data: {
            email: modelFlowUser.email,
            name: modelFlowUser.name,
            image: modelFlowUser.avatar,
            emailVerified: new Date(), // Auto-verify since they logged into ModelFlow
            // You can add more fields here if your schema has them
            // isActive: modelFlowUser.isActive,
          },
        });
      } catch (createError) {
        console.error("Error creating user:", createError);
        // If user creation fails but they exist (race condition), try to fetch again
        simUser = await db.user.findUnique({
          where: { email: modelFlowUser.email },
        });

        if (!simUser) {
          return NextResponse.redirect(
            new URL("/login?error=user_creation_failed", request.url)
          );
        }
      }
    }

    // Create a session for this user using Better Auth
    // This depends on how Better Auth is configured in your Sim instance
    // You might need to use the auth library directly

    try {
      // Import the auth instance from your Sim setup
      // const { auth } = await import('@/lib/auth');
      // const session = await auth.createSession({
      //   userId: simUser.id,
      // });

      // For now, we'll set a cookie manually (Better Auth handles this internally)
      // You'll need to use Better Auth's session creation properly

      const response = NextResponse.redirect(new URL("/agents", request.url));

      // Set appropriate cookies for authentication
      // This is handled by Better Auth, so we just redirect
      // Better Auth middleware will handle the session creation

      return response;
    } catch (sessionError) {
      console.error("Error creating session:", sessionError);
      return NextResponse.redirect(
        new URL("/login?error=session_creation_failed", request.url)
      );
    }
  } catch (error) {
    console.error("ModelFlow SSO error:", error);
    return NextResponse.redirect(
      new URL("/login?error=sso_failed", request.url)
    );
  }
}

export async function POST(request: NextRequest) {
  // Also support POST for flexibility
  try {
    const body = await request.json();
    const token = body.token;

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    // Validate the token
    let modelFlowUser: ModelFlowTokenPayload;
    try {
      modelFlowUser = validateModelFlowToken(token);
    } catch (error) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    // Check if user exists in Sim database
    let simUser = await db.user.findUnique({
      where: { email: modelFlowUser.email },
    });

    // If user doesn't exist, create them
    if (!simUser) {
      simUser = await db.user.create({
        data: {
          email: modelFlowUser.email,
          name: modelFlowUser.name,
          image: modelFlowUser.avatar,
          emailVerified: new Date(),
        },
      });
    }

    return NextResponse.json(
      {
        success: true,
        user: {
          id: simUser.id,
          email: simUser.email,
          name: simUser.name,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("ModelFlow SSO POST error:", error);
    return NextResponse.json({ error: "SSO failed" }, { status: 500 });
  }
}
