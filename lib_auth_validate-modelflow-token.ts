/**
 * Sim utility to validate ModelFlow SSO tokens
 * This should be placed in: sim/apps/sim/lib/auth/validate-modelflow-token.ts
 */

import jwt from 'jsonwebtoken';

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
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/**
 * Validate and decode a ModelFlow SSO token
 * @param token - The JWT token from ModelFlow
 * @returns Decoded user data if valid
 * @throws Error if token is invalid or expired
 */
export function validateModelFlowToken(
  token: string,
  secret: string = process.env.MODELFLOW_SIM_SHARED_SECRET || process.env.JWT_SECRET || ''
): ModelFlowTokenPayload {
  if (!secret) {
    throw new Error('MODELFLOW_SIM_SHARED_SECRET or JWT_SECRET not configured');
  }

  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: 'modelflow-api',
      audience: 'sim-sso',
    }) as ModelFlowTokenPayload;

    // Verify token came from ModelFlow
    if (decoded.source !== 'modelflow') {
      throw new Error('Invalid token source');
    }

    return decoded;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new Error('Handoff token has expired. Please log in again to ModelFlow.');
    } else if (error instanceof jwt.JsonWebTokenError) {
      throw new Error('Invalid token. Please log in again to ModelFlow.');
    } else if (error instanceof Error) {
      throw new Error(`Token validation failed: ${error.message}`);
    } else {
      throw new Error('Token validation failed');
    }
  }
}

export type { ModelFlowTokenPayload };
