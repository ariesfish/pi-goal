import assert from "node:assert/strict";
import test from "node:test";

import { checkResearchWorkspace, formatWorkspaceSafetyError } from "../../extensions/pi-goal/workspace/research-workspace.ts";

test("dirty tree check separates research state from user changes", async () => {
  const check = await checkResearchWorkspace({
    async exec() {
      return {
        code: 0,
        stdout: " M src/app.ts\n?? goal.md\n?? goal.hooks/before.sh\n",
        stderr: "",
      };
    },
  }, "/repo");

  assert.equal(check.clean, false);
  assert.deepEqual(check.userPaths, ["src/app.ts"]);
  assert.deepEqual(check.researchPaths, ["goal.md", "goal.hooks/before.sh"]);
  assert.match(formatWorkspaceSafetyError(check), /src\/app\.ts/);
});
