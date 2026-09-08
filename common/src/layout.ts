/**
 * Paperclip-hosted office-layout configuration wire contract (R3-WS4a).
 *
 * The Paperclip plugin hosts a **declarative, host-neutral office layout** that
 * the Pixel Agents plugin applies spatially. This module owns the serializable
 * shapes both sides share. It stays neutral (board Revision 3 "schemas only"):
 * no file paths, no host/plugin imports, no renderer types — only normalized
 * 0..1 coordinates plus lexical labels and ids, so the same layout can be
 * rendered by any host.
 *
 * Coordinates and sizes are normalized to a [0, 1] unit square so a layout is
 * resolution/container independent; every consumer scales it to its own
 * canvas. This keeps the payload a pure data contract rather than a positional
 * pixel spec.
 */

import { z } from "zod";

/** Layout wire schema version (kept in lockstep with the package constants). */
export const LAYOUT_SCHEMA_VERSION = 1 as const;

/** Layout object kinds allowed on a wall (host-neutral vocabulary). */
export const WALL_KINDS = ["solid", "glass", "partition"] as const;
export type WallKind = (typeof WALL_KINDS)[number];

/** A normalized point in the unit square ([0, 1] on each axis). */
export interface LayoutPoint {
  x: number;
  y: number;
}

export const LayoutPointSchema: z.ZodType<LayoutPoint> = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

/** A normalized size in the unit square (width/height in [0, 1]). */
export interface LayoutSize {
  width: number;
  height: number;
}

export const LayoutSizeSchema: z.ZodType<LayoutSize> = z.object({
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

/** A single wall segment (line in normalized space). */
export interface OfficeWall {
  id: string;
  from: LayoutPoint;
  to: LayoutPoint;
  kind: WallKind;
  color?: string;
}

export const OfficeWallSchema: z.ZodType<OfficeWall> = z.object({
  id: z.string().min(1),
  from: LayoutPointSchema,
  to: LayoutPointSchema,
  kind: z.enum(WALL_KINDS),
  color: z.string().min(1).optional(),
});

/** A piece of furniture / decor placed on a floor. */
export interface OfficeFurniture {
  id: string;
  kind: string;
  position: LayoutPoint;
  size: LayoutSize;
  rotation: number;
  color?: string;
  label?: string;
}

export const OfficeFurnitureSchema: z.ZodType<OfficeFurniture> = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  position: LayoutPointSchema,
  size: LayoutSizeSchema,
  rotation: z.number(),
  color: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
});

/** A seat / character anchor. `agentId` is the Paperclip agent id when a
 *  character is parked here; null/absent means the seat is unassigned. */
export interface OfficeSeat {
  id: string;
  agentId: string | null;
  position: LayoutPoint;
  label?: string;
}

export const OfficeSeatSchema: z.ZodType<OfficeSeat> = z.object({
  id: z.string().min(1),
  agentId: z.string().nullable(),
  position: LayoutPointSchema,
  label: z.string().min(1).optional(),
});

/** One floor (room) in the office. */
export interface OfficeFloor {
  id: string;
  name: string;
  walls: OfficeWall[];
  furniture: OfficeFurniture[];
  seats: OfficeSeat[];
}

export const OfficeFloorSchema: z.ZodType<OfficeFloor> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  walls: z.array(OfficeWallSchema),
  furniture: z.array(OfficeFurnitureSchema),
  seats: z.array(OfficeSeatSchema),
});

/** A complete declarative office layout hosted by Paperclip. */
export interface OfficeLayout {
  schemaVersion: 1;
  name: string;
  floors: OfficeFloor[];
}

export const OfficeLayoutSchema: z.ZodType<OfficeLayout> = z.object({
  schemaVersion: z.literal(LAYOUT_SCHEMA_VERSION),
  name: z.string().min(1),
  floors: z.array(OfficeFloorSchema),
});

/** Parse result for an untrusted office-layout payload. */
export type OfficeLayoutParseResult =
  | { ok: true; layout: OfficeLayout }
  | { ok: false; errors: string[] };

/**
 * Validate an untrusted office-layout payload, returning every violation. The
 * caller decides the fail-closed posture (reject the write, refuse to apply).
 */
export function validateOfficeLayout(input: unknown): OfficeLayoutParseResult {
  const parsed = OfficeLayoutSchema.safeParse(input);
  if (parsed.success) return { ok: true, layout: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      const loc = path.length > 0 ? `${path}: ` : "";
      return `${loc}${issue.message}`;
    }),
  };
}

/** True when a payload is a valid, current office-layout. */
export function isOfficeLayout(input: unknown): input is OfficeLayout {
  return OfficeLayoutSchema.safeParse(input).success;
}
