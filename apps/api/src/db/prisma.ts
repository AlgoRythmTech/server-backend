import { PrismaClient } from '@prisma/client';
import { logger } from '../logger.js';

let cached: PrismaClient | null = null;

export function getPrisma(): PrismaClient {
  if (cached) return cached;
  cached = new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
    // Neon free tier closes idle connections after 5 minutes.
    // This keeps the connection alive during long builds.
    datasourceUrl: process.env.DATABASE_URL,
  });
  cached.$on('warn' as never, (e: unknown) => logger.warn({ prisma: e }, 'prisma warn'));
  cached.$on('error' as never, (e: unknown) => {
    logger.error({ prisma: e }, 'prisma error');
    // Auto-reconnect on connection closed errors
    const msg = String((e as { message?: string })?.message ?? '');
    if (msg.includes('Closed') || msg.includes('connection') || msg.includes('timed out')) {
      logger.info('prisma connection lost — will reconnect on next query');
    }
  });
  return cached;
}

/**
 * Ensure Prisma is connected. Neon free tier drops idle connections
 * after 5 minutes. Call this before Prisma operations that happen
 * after a long pause (like after GLM-5.1 spends 2 minutes thinking).
 */
export async function ensurePrismaConnected(): Promise<void> {
  try {
    const prisma = getPrisma();
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch {
    logger.info('prisma reconnecting after idle timeout...');
    if (cached) {
      try { await cached.$disconnect(); } catch { /* ignore */ }
      cached = null;
    }
    await getPrisma().$connect();
    logger.info('prisma reconnected');
  }
}

export async function disconnectPrisma() {
  if (cached) {
    await cached.$disconnect();
    cached = null;
  }
}
