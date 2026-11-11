// Who turns which case on (SEL-71 split, leader decision): the ts ratchet is per case, these lists say which issue owns which case.
//   SEL-71 (a) — pes.ts skeleton + the WRITE commands (+ `status`, which E04 uses): E01~E04, E10, X01~X05, SEL-75 set lock, W1 importer path.
//   SEL-77 (b) — the READ / report commands: E05, E06, E07 (reads), E11, E12, X06, X07, and the W2 generated-text LF of reports.
//   later      — serve.ts / setup.ts / doctor: E08, E09, E13, E14, E15.
// E07 mixes both; its write half is the contract case X05 (SEL-71), the whole E07 is SEL-77's.
import { all_cases } from "./compat_cases.ts";

export const SEL71_DONE = ["E01", "E02", "E03", "E04", "E10", "X01", "X02", "X03", "X04", "X05"];
export const SEL77_DONE = ["E05", "E06", "E07", "E11", "E12", "X06", "X07"];
export const LATER = ["E08", "E09", "E13", "E14", "E15"];

/** SEL-77 turns itself on by setting these cases to implemented in cases.json / contract.json (all of them at once). */
export function sel77_on(): boolean {
  const status = (id: string): string => all_cases().find((c) => c.id === id)?.ts.status ?? "missing";
  return SEL77_DONE.every((id) => status(id) === "implemented");
}
