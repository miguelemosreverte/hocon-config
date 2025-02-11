const fs = require("fs");
const path = require("path");

/**
 * parseFile(filePath, [options]):
 *   Reads a .conf file from disk, merges includes, environment expansions, partial array logic, etc.
 *   Also optionally merges programmatic overrides if options.overrides is set.
 *
 *   options:
 *     debug?: boolean        (if true, logs debug info)
 *     overrides?: Record<string, any>  (map of dotted keys to final values)
 */
function parseFile(filePath, options = {}) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf8");
  return parseString(content, path.dirname(absPath), options);
}

/**
 * parseString(content, baseDir, [options]):
 *   Parses raw HOCON content from a string, similarly merging environment expansions, includes, partial array merges, overrides, etc.
 *
 *   options:
 *     debug?: boolean
 *     overrides?: Record<string, any>
 */
function parseString(content, baseDir, options = {}) {
  const { debug = false, overrides = null } = options;

  dbg(
    debug,
    `parseString() baseDir=${baseDir || "."}, content length=${content.length}`,
  );

  // 1) Split lines on newlines, trim, remove empty/#// lines
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  dbg(
    debug,
    `Found ${lines.length} relevant lines after filtering comments/empties`,
  );

  let currentIndex = 0;
  const result = {};

  // parseBlock() – reads lines until '}' or EOF, populating parentObj
  function parseBlock(parentObj) {
    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      dbg(debug, `Line ${currentIndex + 1}/${lines.length} => "${line}"`);

      // End of a block
      if (line.startsWith("}")) {
        dbg(debug, "Ending block");
        return;
      }

      // includes
      if (line.startsWith("include ")) {
        dbg(debug, "Found include directive");
        handleInclude(line, parentObj);
        currentIndex++;
        continue;
      }

      // single-line nested block: parent { child = foo }
      let match = line.match(/^([^=:]+?)\{\s*(.*?)\s*\}\s*$/);
      if (match) {
        const key = match[1].trim();
        const inner = match[2].trim();
        dbg(debug, `Single-line block for key=${key}`);
        const childObj = parseString(inner, baseDir, options);
        setVal(parentObj, key, childObj, debug);
        currentIndex++;
        continue;
      }

      // multi-line nested block: parent {
      match = line.match(/^([^=:]+?)\{\s*$/);
      if (match) {
        const key = match[1].trim();
        dbg(debug, `Starting multi-line block for key=${key}`);
        currentIndex++;
        const childObj = {};
        parseBlock(childObj);
        // skip closing brace
        if (lines[currentIndex] && lines[currentIndex].startsWith("}")) {
          currentIndex++;
        }
        setVal(parentObj, key, childObj, debug);
        continue;
      }

      // key-value: key = value
      match = line.match(/^(.+?)\s*[=:]\s*(.+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        dbg(debug, `KeyValue => ${dottedKey} = ${rawVal}`);
        assignValue(parentObj, dottedKey, rawVal);
        currentIndex++;
        continue;
      }

      // If none matched, skip
      dbg(debug, "No pattern matched, skipping line");
      currentIndex++;
    }
  }

  function handleInclude(line, parentObj) {
    // e.g. include "some.conf"
    dbg(debug, `Processing include line => ${line}`);
    const m = line.match(/^include\s+"(.+)"$/);
    if (!m) {
      dbg(debug, "Include syntax not matched, ignoring");
      return;
    }
    const incFile = m[1];
    const incPath = path.resolve(baseDir || ".", incFile);
    dbg(debug, `Include path => ${incPath}`);
    if (!fs.existsSync(incPath)) {
      dbg(debug, `Warning: include file not found => ${incPath}`);
      return;
    }
    const includedObj = parseFile(incPath, options);
    dbg(debug, "Merging included object =>", includedObj);
    mergeObjs(parentObj, includedObj, debug);
  }

  function assignValue(obj, dottedKey, rawVal) {
    // inline object?
    if (rawVal.startsWith("{") && rawVal.endsWith("}")) {
      dbg(debug, `Inline object for => ${dottedKey}`);
      const inner = rawVal.slice(1, -1).trim();
      const childParsed = parseString(inner, baseDir, options);
      setVal(obj, dottedKey, childParsed, debug);
      return;
    }

    // array?
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      dbg(debug, `Array for => ${dottedKey}`);
      const arrInner = rawVal.slice(1, -1).trim();
      let arr = [];
      if (arrInner) {
        arr = arrInner.split(",").map((it) => resolveEnv(it.trim()));
      }
      // If arr == [undefined], skip if there's an existing array
      if (arr.length === 1 && arr[0] === undefined) {
        const existing = getVal(obj, dottedKey);
        if (Array.isArray(existing) && existing.length > 0) {
          dbg(debug, `[undefined] array override => skip`);
          return;
        }
      }
      setVal(obj, dottedKey, arr, debug);
      return;
    }

    // Otherwise treat as string / env expansion
    const val = resolveEnv(rawVal);
    const existingVal = getVal(obj, dottedKey);
    if (val === undefined && existingVal !== undefined) {
      dbg(debug, `Skipping undefined => keep old for ${dottedKey}`);
      return;
    }
    setVal(obj, dottedKey, val, debug);
  }

  function resolveEnv(v) {
    dbg(debug, `Resolving env => ${v}`);
    // strip quotes
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
      dbg(debug, `Stripped quotes => ${v}`);
    }

    // ?VAR
    let m = v.match(/^\?([\w_]+)$/);
    if (m) {
      const envVar = process.env[m[1]];
      dbg(debug, `Resolved short env => ${m[1]} => ${envVar}`);
      return envVar;
    }

    // ${?VAR}
    m = v.match(/^\$\{\?([\w_]+)\}$/);
    if (m) {
      const envVar = process.env[m[1]];
      dbg(debug, `Resolved curly env => ${m[1]} => ${envVar}`);
      return envVar;
    }

    return v;
  }

  function mergeObjs(target, source, debug) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      dbg(debug, "mergeObjs => direct override");
      return source;
    }
    dbg(debug, "mergeObjs => merging object keys");
    for (const [k, v] of Object.entries(source)) {
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        target[k] &&
        typeof target[k] === "object" &&
        !Array.isArray(target[k])
      ) {
        dbg(debug, `mergeObjs => deep merging key=${k}`);
        mergeObjs(target[k], v, debug);
      } else if (Array.isArray(v) && Array.isArray(target[k])) {
        // partial array merges
        if (v.length === 1 && v[0] === undefined) {
          dbg(debug, `Skipping [undefined] override for key=${k}`);
        } else if (v.length === 1 && v[0] !== undefined) {
          dbg(debug, `Overriding first array element for key=${k}`);
          target[k][0] = v[0];
        } else {
          dbg(debug, `Full array override for key=${k}`);
          target[k] = v;
        }
      } else {
        dbg(debug, `mergeObjs => direct override for key=${k}`);
        target[k] = v;
      }
    }
    return target;
  }

  function setVal(obj, dottedKey, value, debug) {
    dbg(debug, `setVal => path=${dottedKey}, val=${JSON.stringify(value)}`);
    const parts = dottedKey.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!cur[p] || typeof cur[p] !== "object") {
        dbg(debug, `Creating new subobj => ${parts.slice(0, i + 1).join(".")}`);
        cur[p] = {};
      }
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function getVal(obj, dottedKey) {
    const parts = dottedKey.split(".");
    let cur = obj;
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[p];
    }
    return cur;
  }

  function dbg(flag, ...args) {
    if (flag) console.debug(...args);
  }

  // parse top-level
  dbg(debug, "Begin parseBlock for top-level");
  parseBlock(result);

  // If we have programmatic overrides, apply them last
  if (overrides && typeof overrides === "object") {
    dbg(debug, `Applying overrides => ${JSON.stringify(overrides)}`);
    // Simple approach: each override => setVal
    for (const [k, v] of Object.entries(overrides)) {
      setVal(result, k, v, debug);
    }
  }

  dbg(debug, "Done parsing => final object:", JSON.stringify(result, null, 2));
  return result;
}

/**
 * parse(filePath, [runtimeOptions]):
 * 1) Gather overrides from process.env + process.argv
 * 2) parseFile(...) with those overrides
 *
 *   runtimeOptions:
 *     envPrefix?: string  (default "HOCON_")
 *     parseEnv?: boolean  (default true)
 *     parseArgs?: boolean (default true)
 *     debug?: boolean
 */
function parse(filePath, runtimeOptions = {}) {
  const {
    envPrefix = "HOCON_",
    parseEnv = true,
    parseArgs = true,
    debug = false,
  } = runtimeOptions;

  // Collect env-based overrides
  let envMap = {};
  if (parseEnv) envMap = buildEnvMap(process.env, envPrefix);

  // Collect arg-based overrides
  let argMap = {};
  if (parseArgs) {
    const argv = process.argv.slice(2);
    argMap = buildArgMap(argv);
  }

  // Combine (args override env)
  const finalOverrides = { ...envMap, ...argMap };

  // Now parse the file with these overrides
  return parseFile(filePath, {
    debug,
    overrides: finalOverrides,
  });
}

/**
 * buildEnvMap(env, prefix):
 *  Example: If env has HOCON_app_name=MyApp,
 *   => dotted key "app.name" = "MyApp"
 */
function buildEnvMap(env, prefix) {
  const map = {};
  for (const [key, val] of Object.entries(env)) {
    if (key.startsWith(prefix)) {
      const stripped = key.slice(prefix.length); // e.g. "app_name"
      // Convert underscores to dots => "app.name"
      const dotted = stripped.replace(/_/g, ".");
      map[dotted] = val;
    }
  }
  return map;
}

/**
 * buildArgMap(args):
 *  e.g. --server.ports=[9000,8000] => "server.ports" : "[9000,8000]"
 *       --app.name=OverrideName   => "app.name" : "OverrideName"
 */
function buildArgMap(args) {
  const map = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const eqIdx = arg.indexOf("=");
    if (eqIdx < 2) continue;
    const key = arg.slice(2, eqIdx); // e.g. "server.ports"
    const val = arg.slice(eqIdx + 1); // e.g. "[9000,8000]"
    map[key] = val;
  }
  return map;
}

// Exports with short function names:
module.exports = {
  parse,
  parseFile,
  parseString,
};
