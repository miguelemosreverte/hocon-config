const path = require("path");
const fs = require("fs");
const { parseFile, parseString, parse } = require("../lib/hoconParser");

describe("HOCON Parser - Extended Tests", () => {
  beforeEach(() => {
    // Clear environment variables before each test
    delete process.env.TEST_VAR;
    delete process.env.UNDEFINED_VAR;
    delete process.env.APP_PORT;
    delete process.env.FEATURE_FLAG;
  });

  test("parses a basic key-value pair from a string", () => {
    const hocon = "key = value";
    const result = parseString(hocon, __dirname);
    expect(result.key).toBe("value");
  });

  test("handles nested objects (single-line)", () => {
    const hocon = "parent { child = hello }";
    const result = parseString(hocon, __dirname);
    expect(result.parent).toBeDefined();
    expect(result.parent.child).toBe("hello");
  });

  test("handles nested objects (multi-line)", () => {
    const hocon = `
      parent {
        child = "hello"
        inner {
          foo = 123
        }
      }
    `;
    const result = parseString(hocon, __dirname);
    expect(result.parent).toBeDefined();
    expect(result.parent.child).toBe("hello");
    expect(result.parent.inner.foo).toBe("123");
  });

  test("handles arrays", () => {
    const hocon = "numbers = [1, 2, 3]";
    const result = parseString(hocon, __dirname);
    expect(result.numbers).toEqual(["1", "2", "3"]);
  });

  test("skips overriding array if it is [undefined]", () => {
    // Suppose we have an existing object
    const base = parseString("arr = [1, 2, 3]", __dirname);

    // Now parse a second string that sets arr = [${?SOME_ENV}] but SOME_ENV not defined
    const override = parseString("arr = [${?SOME_ENV}]", __dirname);

    // Simulate merging the second into the first
    const merged = { ...base };
    Object.entries(override).forEach(([k, v]) => {
      // if v is [undefined], skip
      if (Array.isArray(v) && v.length === 1 && v[0] === undefined) {
        return;
      }
      // otherwise override
      merged[k] = v;
    });

    expect(merged.arr).toEqual(["1", "2", "3"]);
  });

  test("handles environment variable expansion (${?TEST_VAR})", () => {
    process.env.TEST_VAR = "foo";
    const hocon = "someConfig = ${?TEST_VAR}";
    const result = parseString(hocon, __dirname);
    expect(result.someConfig).toBe("foo");
  });

  test("handles environment variable expansion (?TEST_VAR shorthand)", () => {
    process.env.TEST_VAR = "foo";
    const hocon = "anotherConfig = ?TEST_VAR";
    const result = parseString(hocon, __dirname);
    expect(result.anotherConfig).toBe("foo");
  });

  test("ignores undefined environment variable, preserving existing value", () => {
    const hocon = `
      someConfig = "defaultValue"
      someConfig = ${"?UNDEFINED_VAR"}
    `;
    const result = parseString(hocon, __dirname);
    expect(result.someConfig).toBe("defaultValue");
  });

  test("strips quotes from string values", () => {
    const hocon = `
      unquoted = hello
      singleQuoted = 'hello single'
      doubleQuoted = "hello double"
    `;
    const result = parseString(hocon, __dirname);
    expect(result.unquoted).toBe("hello");
    expect(result.singleQuoted).toBe("hello single");
    expect(result.doubleQuoted).toBe("hello double");
  });

  test("handles dotted keys to produce nested objects", () => {
    const hocon = `
      app.name = "MyApp"
      app.version = 1.2
      app.inner.deep.key = "deepValue"
    `;
    const result = parseString(hocon, __dirname);
    expect(result.app).toBeDefined();
    expect(result.app.name).toBe("MyApp");
    expect(result.app.version).toBe("1.2");
    expect(result.app.inner.deep.key).toBe("deepValue");
  });

  test("last definition wins in the same file", () => {
    const hocon = `
      key = "first"
      key = "second"
    `;
    const result = parseString(hocon, __dirname);
    expect(result.key).toBe("second");
  });

  test("ignores # and // commented lines", () => {
    const hocon = `
      # This is a comment
      // Another comment
      realKey = realValue
    `;
    const result = parseString(hocon, __dirname);
    expect(Object.keys(result).length).toBe(1);
    expect(result.realKey).toBe("realValue");
  });

  test("merges deeply nested objects (manual simulate)", () => {
    const base = parseString(
      `
      nested {
        a = 1
        b = 2
        inner {
          x = "xval"
        }
      }
    `,
      __dirname,
    );

    const override = parseString(
      `
      nested {
        b = 99
        inner {
          x = "X_OVERRIDE"
          y = "new"
        }
      }
    `,
      __dirname,
    );

    // simulate merge
    const merged = { ...base };
    Object.entries(override).forEach(([k, v]) => {
      if (
        merged[k] &&
        typeof merged[k] === "object" &&
        !Array.isArray(merged[k]) &&
        typeof v === "object" &&
        !Array.isArray(v)
      ) {
        Object.assign(merged[k], v);
      } else {
        merged[k] = v;
      }
    });

    expect(merged.nested.a).toBe("1");
    expect(merged.nested.b).toBe("99");
    expect(merged.nested.inner.x).toBe("X_OVERRIDE");
    expect(merged.nested.inner.y).toBe("new");
  });

  // The original test for base.conf + overrides.conf
  test("parses from a file with includes and merges", () => {
    const baseFile = path.join(__dirname, ".", "config", "base.conf");
    const config = parseFile(baseFile);
    // base.conf sets app.name to "ExampleApp"
    // overrides.conf changes it to "ExampleApp-Overridden"
    expect(config.app.name).toBe("ExampleApp-Overridden");
    // Check nested object
    expect(config.database.host).toBe("localhost");
    // Check array from base.conf => [8080, 9090, 10000] by default
    expect(config.server.ports).toContain("8080");
  });

  test("multiple includes chain", () => {
    const tmpDir = path.join(__dirname, "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

    const fileA = path.join(tmpDir, "a.conf");
    const fileB = path.join(tmpDir, "b.conf");
    const fileC = path.join(tmpDir, "c.conf");

    fs.writeFileSync(
      fileA,
      `
      a.key = "A"
      include "b.conf"
    `,
    );
    fs.writeFileSync(
      fileB,
      `
      b.key = "B"
      include "c.conf"
    `,
    );
    fs.writeFileSync(
      fileC,
      `
      c.key = "C"
    `,
    );

    const result = parseFile(fileA);
    expect(result.a.key).toBe("A");
    expect(result.b.key).toBe("B");
    expect(result.c.key).toBe("C");

    // Clean up
    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
    fs.unlinkSync(fileC);
    fs.rmdirSync(tmpDir);
  });

  test("partial array override if environment is set", () => {
    // config has server.ports = [8080, 9090, 10000]
    // overrides does server.ports = [${?APP_PORT}]
    // If APP_PORT is set, it overrides only the first element
    process.env.APP_PORT = "9999";
    const baseFile = path.join(__dirname, ".", "config", "base.conf");
    const config = parseFile(baseFile);
    expect(config.server.ports[0]).toBe("9999");
    expect(config.server.ports[1]).toBe("9090");
    expect(config.server.ports[2]).toBe("10000");
  });

  test("skips array override if environment is not set", () => {
    const baseFile = path.join(__dirname, ".", "config", "base.conf");
    const config = parseFile(baseFile);
    expect(config.server.ports).toEqual(["8080", "9090", "10000"]);
  });

  test("applies programmatic overrides last", () => {
    // base file sets some defaults
    const hocon = `
      app.name = "OriginalApp"
      server.port = 8080
      feature.flag = ${"?FEATURE_FLAG"} // might be from environment
    `;

    // set environment to demonstrate environment override
    process.env.FEATURE_FLAG = "false";

    // parse with environment first, then override programmatically
    const result = parseString(hocon, __dirname, {
      overrides: {
        "app.name": "OverrideAppName",
        "server.port": 9999,
        "feature.flag": "true",
      },
    });

    // final values should reflect the programmatic overrides
    expect(result.app.name).toBe("OverrideAppName");
    expect(result.server.port).toBe(9999);
    expect(result.feature.flag).toBe("true");
  });

  test("parse() convenience usage", () => {
    // assume parse(filePath, debug) simply calls parseFile(filePath, { debug })
    const baseFile = path.join(__dirname, ".", "config", "base.conf");
    // We'll call parse with debug=false
    const config = parse(baseFile, { debug: false });

    // Should behave exactly like parseFile
    // base.conf sets app.name => "ExampleApp"
    // overrides.conf => "ExampleApp-Overridden"
    expect(config.app.name).toBe("ExampleApp-Overridden");
    expect(config.database.host).toBe("localhost");
    expect(config.server.ports).toEqual(["8080", "9090", "10000"]);
  });
});
