// One synthetic project for tests. Slugs and names here are invented; no real
// project, institution, or key is used.

import { bootstrap_project, type BootstrapInput, type BootstrapResult } from "../../scripts/pes_core/bootstrap.ts";
import { FakeClock } from "../../scripts/pes_core/clock.ts";
import type { Db } from "../../scripts/pes_core/db.ts";
import { new_id } from "../../scripts/pes_core/ids.ts";

export const SYNTHETIC_PROJECT: BootstrapInput = {
  slug: "synthetic-alpha",
  topic: "합성 정책 연구",
  owner_display_name: "합성 사용자",
};

export interface SyntheticProject {
  project: BootstrapResult;
  clock: FakeClock;
}

export function synthetic_project(
  db: Db,
  input: Partial<BootstrapInput> = {},
  start_ms = 1_760_000_000_000,
): SyntheticProject {
  const clock = new FakeClock(start_ms);
  const project = bootstrap_project(
    db,
    { ...SYNTHETIC_PROJECT, ...input },
    { clock, new_id },
  );
  return { project, clock };
}
