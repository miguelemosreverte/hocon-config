const fs = require("fs");
const path = require("path");

/**
 * parse(filePath, [runtimeOptions]):
 * 1) Gather overrides from process.env + process.argv
 * 2) parseFile(...) with those overrides
 *
 *   runtimeOptions:
 *     envPrefix?: string  (default "")
 *     parseEnv?: boolean  (default true)
 *     parseArgs?: boolean (default true)
 *     debug?: boolean
 */
function parse(filePath, runtimeOptions = {}) {
  const {
    envPrefix = "",
    parseEnv = true,
    parseArgs = true,
    debug = false,
  } = runtimeOptions;

  // gather env-based overrides
  let envMap = {};
  if (parseEnv) envMap = buildEnvMap(process.env, envPrefix);

  // gather CLI-based overrides
  let argMap = {};
  if (parseArgs) {
    const argv = process.argv.slice(2);
    argMap = buildArgMap(argv);
  }

  // combine them
  const finalOverrides = { ...envMap, ...argMap };

  return parseFile(filePath, {
    debug,
    overrides: finalOverrides,
  });
}

/**
 * parseFile(filePath, [options]):
 *   Reads a .conf file from disk, merges includes, environment expansions,
 *   partial array logic, triple-quoted strings, multi-line arrays,
 *   plus any programmatic overrides.
 */
function parseFile(filePath, options = {}) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf8");
  return parseString(content, path.dirname(absPath), options);
}

/**
 * parseString(content, baseDir, [options]):
 *   Parses raw HOCON content from a string, similarly merges
 *   includes, expansions, partial arrays, multiline arrays, triple-quoted strings,
 *   plus optional overrides.
 *
 *   options:
 *     debug?: boolean
 *     overrides?: Record<string, any>
 */
function parseString(content, baseDir, options = {}) {
  const { debug = false, overrides = null } = options;

  dbg(debug, `parseString() baseDir=${baseDir || "."}, len=${content.length}`);

  // 1) Preprocess to unify multi-line arrays & triple-quoted strings
  let lines = preProcessHocon(content, debug);

  // 2) Filter out empty / # / // lines
  lines = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  dbg(debug, `After preProcess, we have ${lines.length} lines`);

  let currentIndex = 0;
  const result = {};

  /** parseBlock: reads lines until '}' or end, populating parentObj */
  function parseBlock(parentObj) {
    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      dbg(debug, `Line ${currentIndex + 1}: ${line}`);

      // End of block?
      if (line.startsWith("}")) {
        dbg(debug, "Block ends here");
        return;
      }

      // 'include "file.conf"'
      if (line.startsWith("include ")) {
        handleInclude(line, parentObj);
        currentIndex++;
        continue;
      }

      // Single-line nested block:  key { child = value }
      let match = line.match(/^([^=:]+?)\{\s*(.*?)\}\s*$/);
      if (match) {
        const key = match[1].trim();
        const inner = match[2].trim();
        dbg(debug, `Single-line block => key=${key}`);
        const childObj = parseString(inner, baseDir, options);
        setVal(parentObj, key, childObj, debug);
        currentIndex++;
        continue;
      }

      // Multi-line block start: key {
      match = line.match(/^([^=:]+?)\{\s*$/);
      if (match) {
        const key = match[1].trim();
        dbg(debug, `Start multi-line block => key=${key}`);
        currentIndex++;
        const childObj = {};
        parseBlock(childObj); // parse nested
        // skip closing brace if present
        if (lines[currentIndex] && lines[currentIndex].startsWith("}")) {
          currentIndex++;
        }
        setVal(parentObj, key, childObj, debug);
        continue;
      }

      // Key-value:  key = value
      match = line.match(/^(.+?)\s*[=:]\s*(.+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        dbg(debug, `KeyValue => ${dottedKey} = ${rawVal}`);
        assignValue(parentObj, dottedKey, rawVal);
        currentIndex++;
        continue;
      }

      dbg(debug, "No pattern matched, skipping line");
      currentIndex++;
    }
  }

  function handleInclude(line, parentObj) {
    // e.g. include "overrides.conf"
    dbg(debug, `handleInclude => ${line}`);
    const m = line.match(/^include\s+"(.+)"$/);
    if (!m) {
      dbg(debug, "Bad include syntax?");
      return;
    }
    const incFile = m[1];
    const incPath = path.resolve(baseDir || ".", incFile);
    dbg(debug, `Include path => ${incPath}`);
    if (!fs.existsSync(incPath)) {
      dbg(debug, `Include file not found => ${incPath}`);
      return;
    }
    const included = parseFile(incPath, options);
    dbg(debug, "Merging included =>", included);
    mergeObjs(parentObj, included, debug);
  }

  function assignValue(obj, dottedKey, rawVal) {
    // Inline object?  { foo=bar }
    if (rawVal.startsWith("{") && rawVal.endsWith("}")) {
      dbg(debug, `Inline object => ${dottedKey}`);
      const inner = rawVal.slice(1, -1).trim();
      const child = parseString(inner, baseDir, options);
      setVal(obj, dottedKey, child, debug);
      return;
    }

    // Array?  [1,2,3]
    if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      dbg(debug, `Array => ${dottedKey}`);
      const arrInner = rawVal.slice(1, -1).trim();
      let arr = [];
      if (arrInner) {
        // parse as comma-split, env expansions
        arr = arrInner.split(",").map((it) => resolveEnv(it.trim(), debug));
      }
      // partial array skip if [undefined]
      if (arr.length === 1 && arr[0] === undefined) {
        const existing = getVal(obj, dottedKey);
        if (Array.isArray(existing) && existing.length > 0) {
          dbg(debug, "[undefined] => skip override");
          return;
        }
      }
      setVal(obj, dottedKey, arr, debug);
      return;
    }

    // Otherwise treat as string or env expansions
    const val = resolveEnv(rawVal, debug);
    const existingVal = getVal(obj, dottedKey);
    if (val === undefined && existingVal !== undefined) {
      dbg(debug, `Skipping undefined => keep old for ${dottedKey}`);
      return;
    }
    setVal(obj, dottedKey, val, debug);
  }

  // parse top-level block
  parseBlock(result);

  // apply overrides last
  if (overrides && typeof overrides === "object") {
    dbg(debug, `Applying overrides => ${JSON.stringify(overrides)}`);
    for (const [k, v] of Object.entries(overrides)) {
      setVal(result, k, v, debug);
    }
  }

  dbg(debug, "Done =>", JSON.stringify(result, null, 2));
  return result;
}

// --- Triple-quoted aware environment expansions ---
function resolveEnv(raw, debug) {
  dbg(debug, `resolveEnv => ${raw}`);

  // 1) Handle triple-quoted string => """..."""
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    // Strip the triple quotes themselves
    let tripleInner = raw.slice(3, -3);
    // Convert \n (backslash-n) to actual newlines
    tripleInner = tripleInner.replace(/\\n/g, "\n");
    dbg(debug, `Triple-quoted => returning multi-line value`);
    return tripleInner;
  }

  // 2) If it's a normally quoted string => "someText" or 'someText'
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
    dbg(debug, `Stripped quotes => ${raw}`);
  }

  // 3) Check for ?VAR => ?FOO or ${?FOO}
  //    If present but undefined in env, we return `undefined`.
  let m = raw.match(/^\?([\w_]+)$/);
  if (m) {
    let envVar = process.env[m[1]];
    dbg(debug, `?ENV => ${m[1]} => ${envVar}`);
    return envVar;
  }
  m = raw.match(/^\$\{\?([\w_]+)\}$/);
  if (m) {
    let envVar = process.env[m[1]];
    dbg(debug, `CurlyENV => ${m[1]} => ${envVar}`);
    return envVar;
  }

  // Otherwise, just return as-is
  return raw;
}

// --- Utility: merge object source => target
function mergeObjs(target, source, debug) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    dbg(debug, "mergeObjs => direct override");
    return source;
  }
  dbg(debug, "mergeObjs => merging keys");
  for (const [k, v] of Object.entries(source)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      target[k] &&
      typeof target[k] === "object" &&
      !Array.isArray(target[k])
    ) {
      dbg(debug, `mergeObjs => deep => key=${k}`);
      mergeObjs(target[k], v, debug);
    } else if (Array.isArray(v) && Array.isArray(target[k])) {
      if (v.length === 1 && v[0] === undefined) {
        dbg(debug, `[undefined] => skip array override => key=${k}`);
      } else if (v.length === 1 && v[0] !== undefined) {
        dbg(debug, `Override first array => key=${k}`);
        target[k][0] = v[0];
      } else {
        dbg(debug, `Full array override => key=${k}`);
        target[k] = v;
      }
    } else {
      dbg(debug, `mergeObjs => direct => key=${k}`);
      target[k] = v;
    }
  }
  return target;
}

// --- Utility: dottedKey => setVal
function setVal(obj, dottedKey, value, debug) {
  dbg(debug, `setVal => path=${dottedKey}, val=${JSON.stringify(value)}`);
  const parts = dottedKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") {
      dbg(debug, `Creating subobj => ${parts.slice(0, i + 1).join(".")}`);
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function getVal(obj, dottedKey) {
  const parts = dottedKey.split(".");
  let c = obj;
  for (const p of parts) {
    if (!c || typeof c !== "object") return undefined;
    c = c[p];
  }
  return c;
}

// --- Utility: debug helper
function dbg(flag, ...args) {
  if (flag) console.debug(...args);
}

/**
 * preProcessHocon(content, debug):
 *   - merges multi-line arrays into a single line
 *   - merges triple-quoted strings into a single line
 *   so parseBlock can handle them with simpler logic.
 *
 * e.g.
 *   someArr = [
 *     1,
 *     2
 *   ]
 * => "someArr = [1, 2]"
 *
 * e.g.
 *   someKey = """Hello
 *   World"""
 * => "someKey = \"\"\"Hello\nWorld\"\"\""
 */
function preProcessHocon(content, debug) {
  const rawLines = content.split("\n");
  let out = [];
  let i = 0;

  while (i < rawLines.length) {
    let line = rawLines[i];
    i++;

    // check triple-quoted start
    if (line.includes('"""')) {
      // e.g. someKey = """  # gather until next """
      let tripleStart = line.indexOf('"""');
      let fullLine = line;
      let searching = line.indexOf('"""', tripleStart + 3) === -1;

      // keep concatenating lines until the closing """
      while (searching && i < rawLines.length) {
        // embed literal "\n" so we can preserve line breaks
        fullLine += "\\n" + rawLines[i];
        if (rawLines[i].includes('"""')) {
          searching = false;
        }
        i++;
      }
      // e.g. "someKey = \"\"\"Hello\nWorld\"\"\""
      out.push(fullLine);
      continue;
    }

    // check if line starts an array "["
    if (line.includes("[") && !line.trim().endsWith("]")) {
      // gather lines until we find matching "]"
      let merged = line;
      let bracketFound = line.includes("]");
      while (!bracketFound && i < rawLines.length) {
        merged += rawLines[i];
        if (rawLines[i].includes("]")) {
          bracketFound = true;
        }
        i++;
      }
      // now we have "someArr = [1,2,...]"
      out.push(merged);
      continue;
    }

    // default: push line as-is
    out.push(line);
  }

  dbg(debug, "preProcess => final lines:\n", out.join("\n"));
  return out;
}

/**
 * Convert environment variables into overrides, using a prefix if desired.
 */
function buildEnvMap(env, prefix) {
  const map = {};
  for (const [key, val] of Object.entries(env)) {
    if (prefix) {
      if (!key.startsWith(prefix)) continue;
      const stripped = key.slice(prefix.length);
      map[stripped.replace(/_/g, ".")] = val;
    } else {
      // no prefix => everything is used => risky, but user asked for it
      map[key.replace(/_/g, ".")] = val;
    }
  }
  return map;
}

/**
 * Convert argv ("--some.key=val") into overrides.
 */
function buildArgMap(args) {
  const map = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const eqIdx = arg.indexOf("=");
    if (eqIdx < 2) continue;
    const dottedKey = arg.slice(2, eqIdx);
    const val = arg.slice(eqIdx + 1);
    map[dottedKey] = val;
  }
  return map;
}

module.exports = {
  parse,
  parseFile,
  parseString,
};
