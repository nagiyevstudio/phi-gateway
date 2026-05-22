import crypto from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { getClients, ClientRecord } from './config';

function decodeStoredDigest(value: string) {
  const parts = value.split('$');
  if (parts.length !== 3) return null;
  const [scheme, salt, digest] = parts;
  if (scheme !== 'scrypt' || !salt || !digest) {
    return null;
  }
  return { salt, digest };
}

function scryptHash(secret: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString('hex'));
    });
  });
}

export async function verifyApiKey(rawApiKey: string, storedHash: string): Promise<boolean> {
  const decoded = decodeStoredDigest(storedHash);
  if (!decoded) return false;
  
  try {
    const actualDigest = await scryptHash(rawApiKey, decoded.salt);
    const left = Buffer.from(actualDigest, 'hex');
    const right = Buffer.from(decoded.digest, 'hex');
    
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
  } catch (error) {
    console.error('[Auth] scrypt hashing failed:', error);
    return false;
  }
}

// Extend FastifyRequest type to include client and telemetry properties
declare module 'fastify' {
  interface FastifyRequest {
    client?: ClientRecord;
    modelAlias?: string;
    upstreamModelKey?: string;
  }
}

export async function authenticateRequest(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();

  if (!token) {
    return reply.status(401).send({
      success: false,
      error: {
        code: 'unauthorized',
        message: 'Missing bearer token.'
      }
    });
  }

  const clients = getClients();
  for (const client of clients) {
    if (!client.enabled) continue;
    const isValid = await verifyApiKey(token, client.key_hash);
    if (isValid) {
      request.client = client;
      return; // Authentication successful
    }
  }

  return reply.status(401).send({
    success: false,
    error: {
      code: 'unauthorized',
      message: 'Invalid bearer token.'
    }
  });
}
