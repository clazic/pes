// One judgement for "does this relative path leave its base folder?" (SEL-105).
// `path.relative(base, target)` answers ".." only for the parent itself and "..<sep>x" for things beside/above it;
// a first segment that merely STARTS with two dots (`..cache`, `...`) is an ordinary child name. Judging with
// `rel.startsWith("..")` takes such a child for "outside" — never write that.

import { isAbsolute, sep } from "node:path";

/** True when `rel` (a `path.relative()` result) points outside its base: absolute (other drive), `..`, or `..<sep>…`. */
export function escapes_parent(rel: string): boolean {
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
}
