// SEL-55 child process: builds the connection entry of one app adapter and reads the launch token from a fake key
// store, under the HOME it was given (a temporary one with planted tool-config files). It prints one JSON line.
// If the adapter ever looked at the home folder of the tool, the planted files would change or the line would say so.
// argv[2] = "codex_app" | "opencode_app". Nothing here starts a tool or reads a file.

const name = process.argv[2] ?? "";
if (name !== "codex_app" && name !== "opencode_app") {
  process.stdout.write(`${JSON.stringify({ error: "bad argument" })}\n`);
  process.exit(2);
}
const mod = (await import(`../../scripts/pes_core/adapters/${name}.ts`)) as Record<string, any>;
const token = "synthetic-token-not-real-child-0001";
const project_id = "synthetic-project-id";
const gets: string[] = [];
const entry = mod[`${name}_mcp_entry`]({
  command: process.execPath,
  server_script: "/path/to/pes/scripts/pes_core/mcp_server.ts",
  project_id,
  api_base_url: "http://127.0.0.1:8760",
});
const launched = await mod[`${name}_launch_env`]({
  key_store: { get: (ref: string) => (gets.push(ref), token) },
  project_id,
});
process.stdout.write(
  `${JSON.stringify({ entry, gets, launched_token_ok: launched.PES_AGENT_TOKEN === token, keys: Object.keys(launched) })}\n`,
);
