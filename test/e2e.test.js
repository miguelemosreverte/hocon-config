const path = require("path");
const { execFileSync } = require("child_process");
const fs = require("fs");

describe("Example.js End-to-End Test", () => {
  test("runs example.js with env + args, checks final config", () => {
    // 1) Ensure example.js & example.conf exist
    const exampleJsPath = path.join(__dirname, "e2e.example.js");
    const exampleConfPath = path.join(__dirname, "config", "example.conf");

    expect(fs.existsSync(exampleJsPath)).toBe(true);
    expect(fs.existsSync(exampleConfPath)).toBe(true);

    // 2) We'll set some environment variables
    const env = {
      ...process.env,
      APP_FLAG: "envFlagValue", // e.g., becomes app.flag = "envFlagValue"
    };

    // 3) We'll pass a CLI argument like `--server.port=9999`
    // This should override the default "3000" in example.conf
    const args = ["--server.port=9999"];

    // 4) Execute example.js in a child process
    //    capturing stdout
    const stdout = execFileSync("node", [exampleJsPath, ...args], {
      env,
    }).toString();

    // 5) Parse stdout as JSON
    const finalConfig = JSON.parse(stdout);

    // 6) Check that environment + CLI overrides appear
    expect(finalConfig.app.name).toBe("ExampleApp"); // from example.conf
    expect(finalConfig.app.flag).toBe("envFlagValue"); // from env
    expect(finalConfig.server.port).toBe("9999"); // from CLI
  });
});
