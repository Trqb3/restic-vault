import {z, ZodSafeParseResult, type ZodType} from 'zod';
import type { Request, Response, NextFunction } from 'express';

/**
 * Express middleware that validates req.body (or req.query / req.params) against a Zod schema.
 * Responds 400 with the first human-readable error message on failure.
 */
export function validate<T>(
  schema: ZodType<T>,
  source: 'body' | 'params' | 'query' = 'body',
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result: ZodSafeParseResult<T> = schema.safeParse(req[source]);
    if (!result.success) {
      const msg: string = result.error.issues[0]?.message ?? 'Validation error';
      res.status(400).json({ error: msg });
      return;
    }
    // Merge coerced/stripped value back.  For 'params' we must merge (not
    // replace) because mergeParams: true puts parent params (e.g. repoId) into
    // req.params — stripping them would make nested routers lose context.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any)[source] =
      source === 'params'
        ? { ...req.params, ...(result.data as object) }
        : result.data;
    next();
  };
}

// ── Shared schema primitives ──────────────────────────────────────────────────

/** Restic snapshot IDs are lowercase hex (8 or 64 chars typically) */
export const snapshotIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8,64}$/, 'Invalid snapshot ID format');

/** Params schema for routes with a single numeric :id segment */
export const numericIdSchema = z
  .string()
  .regex(/^\d+$/, 'ID must be a positive integer');

/** Use this with validate(idParamsSchema, 'params') on routes with /:id */
export const idParamsSchema = z.object({
  id: numericIdSchema,
});
