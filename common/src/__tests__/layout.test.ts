import { describe, expect, it } from "vitest";

import {
  isOfficeLayout,
  validateOfficeLayout,
  type OfficeLayout,
  type OfficeFurniture,
  type OfficeSeat,
  type OfficeWall,
} from "../layout.js";
import {
  buildOfficeFloor,
  buildOfficeFurniture,
  buildOfficeLayout,
  buildOfficeSeat,
  buildOfficeWall,
} from "../fixtures.js";

function without<T extends object>(obj: T, key: keyof T): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
  delete copy[key as string];
  return copy;
}

function layoutWith(overrides: Partial<OfficeLayout> & { walls?: OfficeWall[]; furniture?: OfficeFurniture[]; seats?: OfficeSeat[] }): OfficeLayout {
  const { walls, furniture, seats, ...rest } = overrides;
  return {
    schemaVersion: 1,
    name: "Test layout",
    floors: [
      {
        id: "floor-1",
        name: "Main floor",
        walls: walls ?? [],
        furniture: furniture ?? [],
        seats: seats ?? [],
      },
    ],
    ...rest,
  };
}

function allErrors(input: unknown): string[] {
  const result = validateOfficeLayout(input);
  return result.ok ? [] : result.errors;
}

describe("office-layout fixture builders (R3-WS4a)", () => {
  it("accepts a full layout built by buildOfficeLayout", () => {
    const layout = buildOfficeLayout();
    expect(validateOfficeLayout(layout).ok).toBe(true);
    expect(isOfficeLayout(layout)).toBe(true);
  });

  it("accepts a floor built by buildOfficeFloor", () => {
    const layout: OfficeLayout = { schemaVersion: 1, name: "Test", floors: [buildOfficeFloor()] };
    expect(validateOfficeLayout(layout).ok).toBe(true);
  });

  it("accepts a wall built by buildOfficeWall", () => {
    const layout = layoutWith({ walls: [buildOfficeWall()] });
    expect(validateOfficeLayout(layout).ok).toBe(true);
  });

  it("accepts furniture built by buildOfficeFurniture", () => {
    const layout = layoutWith({ furniture: [buildOfficeFurniture()] });
    expect(validateOfficeLayout(layout).ok).toBe(true);
  });

  it("accepts a seat built by buildOfficeSeat", () => {
    const layout = layoutWith({ seats: [buildOfficeSeat()] });
    expect(validateOfficeLayout(layout).ok).toBe(true);
  });
});

describe("office-layout coordinate validation", () => {
  it("rejects a wall point with an x below 0", () => {
    expect(allErrors(layoutWith({ walls: [buildOfficeWall({ from: { x: -0.1, y: 0 } })] }))).not.toEqual([]);
  });

  it("rejects a wall point with an x above 1", () => {
    expect(allErrors(layoutWith({ walls: [buildOfficeWall({ from: { x: 1.1, y: 0 } })] }))).not.toEqual([]);
  });

  it("rejects a wall point with a y outside the unit square", () => {
    expect(allErrors(layoutWith({ walls: [buildOfficeWall({ to: { x: 1, y: 2 } })] }))).not.toEqual([]);
  });

  it("rejects furniture position or size outside the unit square", () => {
    expect(allErrors(layoutWith({ furniture: [buildOfficeFurniture({ position: { x: 0.5, y: 1.5 } })] }))).not.toEqual([]);
    expect(allErrors(layoutWith({ furniture: [buildOfficeFurniture({ size: { width: -0.1, height: 0.2 } })] }))).not.toEqual([]);
    expect(allErrors(layoutWith({ furniture: [buildOfficeFurniture({ size: { width: 1.2, height: 0.2 } })] }))).not.toEqual([]);
  });

  it("rejects a seat position outside the unit square", () => {
    expect(allErrors(layoutWith({ seats: [buildOfficeSeat({ position: { x: 3, y: 0 } })] }))).not.toEqual([]);
  });
});

describe("office-layout structural validation", () => {
  it("rejects an unknown wall kind", () => {
    const bad = { ...buildOfficeWall(), kind: "brick" } as OfficeWall;
    expect(allErrors(layoutWith({ walls: [bad] }))).not.toEqual([]);
  });

  it("rejects a bad schemaVersion", () => {
    const layout = buildOfficeLayout();
    expect(allErrors({ ...layout, schemaVersion: 2 })).not.toEqual([]);
    expect(allErrors(buildOfficeLayout({ schemaVersion: 999 }))).not.toEqual([]);
  });

  it("rejects an absent schemaVersion", () => {
    const layout: unknown = without(buildOfficeLayout(), "schemaVersion");
    expect(allErrors(layout)).not.toEqual([]);
  });

  it("rejects a missing id on a wall", () => {
    const noId = without(buildOfficeWall(), "id");
    expect(allErrors(layoutWith({ walls: [noId as OfficeWall] }))).not.toEqual([]);
  });

  it("rejects an empty id on a wall", () => {
    expect(allErrors(layoutWith({ walls: [buildOfficeWall({ id: "" })] }))).not.toEqual([]);
  });

  it("rejects a missing id on furniture and seat", () => {
    expect(allErrors(layoutWith({ furniture: [without(buildOfficeFurniture(), "id") as OfficeFurniture] }))).not.toEqual([]);
    expect(allErrors(layoutWith({ seats: [without(buildOfficeSeat(), "id") as OfficeSeat] }))).not.toEqual([]);
  });

  it("rejects a missing name on a floor", () => {
    const floor = buildOfficeFloor();
    const layout: OfficeLayout = { schemaVersion: 1, name: "Test", floors: [without(floor, "name") as typeof floor] };
    expect(allErrors(layout)).not.toEqual([]);
  });

  it("rejects a missing name on the layout", () => {
    const layout: unknown = without(buildOfficeLayout(), "name");
    expect(allErrors(layout)).not.toEqual([]);
  });
});

describe("office-layout JSON round-trip", () => {
  it("still validates after a JSON serialize/parse cycle", () => {
    const layout = buildOfficeLayout();
    const roundTripped = JSON.parse(JSON.stringify(layout)) as OfficeLayout;
    expect(validateOfficeLayout(roundTripped).ok).toBe(true);
    expect(isOfficeLayout(roundTripped)).toBe(true);
  });
});
