// Test-only helper for the serve.py pytest suites: mints one synthetic agent token in the DATABASE of the
// (isolated) HOME/PES_HOME it is run with, through the same core command the owner CLI uses. Prints JSON
// {actor_id, token, token_id}. Argv: <project_id> <owner_actor_id> <agent_actor_id> <scopes,comma,separated>.
// Never run it with a real HOME: the caller (tests/test_serve_api_limits.py) always passes a temp one.
import { issue_agent_token } from "../../scripts/pes_core/actors.ts";
import { SystemClock } from "../../scripts/pes_core/clock.ts";
import { CommandService } from "../../scripts/pes_core/commands.ts";
import { connect } from "../../scripts/pes_core/db.ts";
import { db_path } from "../../scripts/pes_core/paths.ts";

const [project_id, owner_actor_id, agent_actor_id, scopes] = process.argv.slice(2);
const db = connect(db_path(process.env as Record<string, string | undefined>));
try {
  const service = new CommandService(db, {
    clock: new SystemClock(),
    policy: { check: () => ({ allowed: true }) },
  } as ConstructorParameters<typeof CommandService>[1]);
  const out = await issue_agent_token(
    service,
    { project_id, actor_id: owner_actor_id, via: "cli", client_request_id: `mint-${agent_actor_id}` },
    { actor_id: agent_actor_id, scopes: scopes!.split(",") },
  );
  const r = out.result as { token: string; token_id: string };
  process.stdout.write(JSON.stringify({ actor_id: agent_actor_id, token: r.token, token_id: r.token_id }));
} finally {
  db.close();
}
