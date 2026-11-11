// What SEL-72 (PR26c: scripts/serve.ts + scripts/setup.ts) turns on, and what it leaves to the other issues (leader decision).
//   SEL72_DONE — the cases whose ts side is exactly serve.ts or setup.ts: E08 E09 E13 (http) and E14 (setup).
//   E15 (doctor --json) stays not_yet: `doctor` is a scripts/pes.ts command, and it is the pes.ts commands serve / stop / hub / open /
//   watch / doctor that CALL serve.ts — that wiring is SEL-77 and later. This issue does not touch scripts/pes.ts.
export const SEL72_DONE = ["E08", "E09", "E13", "E14"] as const;
export const SEL72_LEFT_TO_LATER = ["E15"] as const;

/** The ts file each done case runs: http cases → serve.ts, the setup case → setup.ts. */
export const SEL72_KIND: Record<(typeof SEL72_DONE)[number], "http" | "setup"> = { E08: "http", E09: "http", E13: "http", E14: "setup" };
