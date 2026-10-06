import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Creates the throwaway test database once per test run and exposes its URL to tests
 * through DATABASE_URL. Requires a local Postgres superuser (see scripts/test-db.sh).
 */
export default function setup() {
  if (process.env.SKIP_TEST_DB === "1") return;
  const script = path.resolve(__dirname, "../../scripts/test-db.sh");
  const url = execFileSync("bash", [script], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop()!;
  process.env.DATABASE_URL = url;
  process.env.TEST_DATABASE_URL = url;
  Object.assign(process.env, { NODE_ENV: "test" });
  process.env.GOOGLE_PROVIDER_MODE = "mock";
  process.env.OPENAI_MODE = "mock";
  process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY ?? "64DOYlUWFcQNmv/P2fXuBSaClIQwklj+A0h/1GhJD/I=";
}
