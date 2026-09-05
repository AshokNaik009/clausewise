import { doctor } from "../src/preflight.js";
import { verifyFixtures } from "../src/fixtures.js";

const result = await doctor();
if (!result.healthy) {
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 7;
} else if (process.argv.includes("--full")) {
  const fixtures = await verifyFixtures(process.cwd());
  process.stdout.write(`${JSON.stringify(fixtures)}\n`);
  if (!fixtures.valid) process.exitCode = 7;
} else {
  process.stdout.write(`${JSON.stringify({ schema_version: "1.0", sanity: "doctor_passed" })}\n`);
}
