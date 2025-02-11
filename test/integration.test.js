const fs = require("fs");
const path = require("path");
const { parseFile } = require("../lib/hoconParser");

/**
 * This test enumerates subfolders in test/scenarios10/.
 * Each folder is a scenario containing:
 *  - README.md (optional, for documentation)
 *  - base.conf (required)
 *  - zero or more .conf files (overrides, etc.)
 *  - an optional .env
 *  - expected.json (required)
 *
 * Steps:
 * 1) Load the .env into process.env (if present)
 * 2) Parse base.conf
 * 3) Compare the resulting config to expected.json
 * 4) If mismatch, re-run parse in debug mode
 * 5) Restore environment
 */
describe("Scenario-based Integration Tests (10 scenarios)", () => {
  const scenariosDir = path.join(__dirname, "scenarios10");

  // list scenario directories, sorted so scenario1.. scenario10 run in sequence
  const scenarioFolders = fs
    .readdirSync(scenariosDir)
    .filter((f) => fs.statSync(path.join(scenariosDir, f)).isDirectory())
    .sort();

  scenarioFolders.forEach((scenarioName) => {
    test(`Scenario: ${scenarioName}`, () => {
      const scenarioPath = path.join(scenariosDir, scenarioName);

      // 1) Backup environment
      const originalEnv = { ...process.env };

      // 2) Load .env if present
      const envFile = path.join(scenarioPath, ".env");
      if (fs.existsSync(envFile)) {
        const lines = fs
          .readFileSync(envFile, "utf8")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"));

        lines.forEach((line) => {
          const eqIdx = line.indexOf("=");
          if (eqIdx > -1) {
            const key = line.slice(0, eqIdx).trim();
            const val = line.slice(eqIdx + 1).trim();
            process.env[key] = val;
          }
        });
      }

      // 3) Parse base.conf
      const baseConfPath = path.join(scenarioPath, "base.conf");
      if (!fs.existsSync(baseConfPath)) {
        throw new Error(`Scenario ${scenarioName} missing base.conf`);
      }
      let finalConfig = parseFile(baseConfPath);

      // 4) Compare result to expected.json
      const expectedJsonPath = path.join(scenarioPath, "expected.json");
      if (!fs.existsSync(expectedJsonPath)) {
        throw new Error(`Scenario ${scenarioName} missing expected.json`);
      }
      const expected = JSON.parse(fs.readFileSync(expectedJsonPath, "utf8"));

      try {
        expect(finalConfig).toEqual(expected);
      } catch (err) {
        // On mismatch, re-run parse in debug mode to see detailed logs
        console.log(
          `\n[SCENARIO: ${scenarioName}] Mismatch detected -- re-run with debug logs:\n`,
        );
        finalConfig = parseFile(baseConfPath, { debug: true });
        // Optionally compare again or just show logs:
        // console.log("Re-parsed final config =>", JSON.stringify(finalConfig, null, 2));
        throw err; // rethrow to fail the test
      } finally {
        // 5) Restore environment
        process.env = originalEnv;
      }
    });
  });
});
