// SEL-103 test tool (`--import`, loaded BEFORE the recorder / the entry): makes os.userInfo().homedir answer PES_FAKE_ACCOUNT_HOME, so a child process has a
// FAKE "account home" while HOME stays a temporary folder — exactly the real situation (account home = the real home, HOME = a temp folder), with nothing
// real in it. Used by test_sel103_no_account_listing to prove that the guard never lists (or realpaths) the account home. Without the variable it does nothing.
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";

const fake = process.env.PES_FAKE_ACCOUNT_HOME;
if (fake !== undefined && fake !== "") {
  const original = os.userInfo;
  (os as { userInfo: typeof os.userInfo }).userInfo = ((options?: Parameters<typeof os.userInfo>[0]) => ({ ...original.call(os, options as never), homedir: fake })) as typeof os.userInfo;
  syncBuiltinESMExports();
}
