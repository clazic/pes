// Test-only helper (SEL-47 regression tests): in the DATABASE of the (isolated) HOME it is run with, migrates,
// creates one synthetic project through the core bootstrap, adds one synthetic agent actor and mints a project
// token for it. It never creates a human session secret, so tests can run the bridge/serve.py with NO
// PES_LOCAL_SESSION_SECRET and NO ~/.pes/config.json — the default state of a real install.
// Prints JSON {project_id, owner_actor_id, actor_id, token}. Argv: <slug> <scopes,comma,separated>.
// Never run it with a real HOME: the callers always pass a temporary one.
import { issue_agent_token } from "../../scripts/pes_core/actors.ts";
import { bootstrap_project } from "../../scripts/pes_core/bootstrap.ts";
import { SystemClock } from "../../scripts/pes_core/clock.ts";
import { CommandService } from "../../scripts/pes_core/commands.ts";
import { connect, migrate } from "../../scripts/pes_core/db.ts";
import { new_id } from "../../scripts/pes_core/ids.ts";
import { db_path } from "../../scripts/pes_core/paths.ts";

const [slug, scopes] = process.argv.slice(2);
const db = connect(db_path(process.env as Record<string, string | undefined>));
try {
  migrate(db);
  const clock = new SystemClock();
  const project = bootstrap_project(
    db,
    { slug: slug!, topic: "합성 주제", owner_display_name: "합성 소유자" },
    { clock, new_id },
  );
  const actor_id = `agent-${slug}`;
  db.run(
    "INSERT INTO actors (id, kind, user_id, display_name) VALUES (?, 'external_agent', ?, ?)",
    actor_id,
    project.owner_user_id,
    "합성 에이전트",
  );
  const service = new CommandService(db, {
    clock,
    policy: { check: () => ({ allowed: true }) },
  } as ConstructorParameters<typeof CommandService>[1]);
  const out = await issue_agent_token(
    service,
    { project_id: project.project_id, actor_id: project.owner_actor_id, via: "cli", client_request_id: `mint-${slug}` },
    { actor_id, scopes: scopes!.split(",") },
  );
  const r = out.result as { token: string };
  process.stdout.write(
    JSON.stringify({ project_id: project.project_id, owner_actor_id: project.owner_actor_id, actor_id, token: r.token }),
  );
} finally {
  db.close();
}
