import jwt from 'jsonwebtoken';

export interface ModelFlowTokenPayload {
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
  aud: string;
  iss: string;
}

export function validateModelFlowToken(
  token: string,
  secret: string
): ModelFlowTokenPayload {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: 'modelflow-api',
      audience: 'agent-builder-sso',
      ignoreExpiration: process.env.NODE_ENV === 'development',
    }) as ModelFlowTokenPayload;

    // Additional validation
    if (decoded.source !== 'modelflow') {
      throw new Error('Invalid token source');
    }

    return decoded;
  } catch (error: any) {
    throw new Error(`Token validation failed: ${error.message}`);
  }
}
