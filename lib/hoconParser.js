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

      // => detect plus-assign => key += ...
      match = line.match(/^(.+?)\s*\+=\s*(.+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        dbg(debug, `PlusAssign => ${dottedKey} += ${rawVal}`);
        plusAssignValue(parentObj, dottedKey, rawVal);
        currentIndex++;
        continue;
      }

      // => Key-value => key = ...
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

  /**
   * Helper: check for undefined or null
   */
  function isUndefOrNull(x) {
    return x === undefined || x === null;
  }

  /**
   * assignValue => normal '='
   * If newVal is undefined/null => skip if there's an existing value
   * If newVal is a partial array [undefined/null] => skip if existing is a non-empty array
   */
  function assignValue(obj, dottedKey, rawVal) {
    const newVal = parseInlineValue(rawVal, baseDir, debug);
    const existingVal = getVal(obj, dottedKey);

    // (1) If the new value is strictly undefined or null, preserve old
    if (isUndefOrNull(newVal)) {
      if (!isUndefOrNull(existingVal)) {
        dbg(debug, `Skipping undefined or null => keep old for ${dottedKey}`);
        return;
      }
    }

    // (2) If the new value is a partial array => e.g. [undefined or null]
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      isUndefOrNull(newVal[0])
    ) {
      if (Array.isArray(existingVal) && existingVal.length > 0) {
        dbg(debug, `[undefined/null] => skip override => key=${dottedKey}`);
        return;
      }
    }

    setVal(obj, dottedKey, newVal, debug);
  }

  /**
   * plusAssignValue => 'key += ...'
   * Similar skip if the newVal is undefined/null or partial array => preserve old
   */
  function plusAssignValue(obj, dottedKey, rawVal) {
    const newVal = parseInlineValue(rawVal, baseDir, debug);
    const existingVal = getVal(obj, dottedKey);

    // If there's no existing, just set
    if (existingVal === undefined) {
      setVal(obj, dottedKey, newVal, debug);
      return;
    }

    // If newVal is undefined/null => skip
    if (isUndefOrNull(newVal)) {
      dbg(debug, `Skipping undefined/null => keep old for ${dottedKey}`);
      return;
    }

    // If partial array => skip
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      isUndefOrNull(newVal[0])
    ) {
      if (Array.isArray(existingVal) && existingVal.length > 0) {
        dbg(
          debug,
          `[undefined/null] => skip array override => key=${dottedKey}`,
        );
        return;
      }
    }

    // now do merges or overrides
    if (Array.isArray(newVal)) {
      if (Array.isArray(existingVal)) {
        // array += array => concat
        setVal(obj, dottedKey, existingVal.concat(newVal), debug);
      } else {
        dbg(
          debug,
          `Plus-assign => existing not array => overwriting => ${dottedKey}`,
        );
        setVal(obj, dottedKey, newVal, debug);
      }
      return;
    }

    if (newVal && typeof newVal === "object") {
      if (
        existingVal &&
        typeof existingVal === "object" &&
        !Array.isArray(existingVal)
      ) {
        mergeObjs(existingVal, newVal, debug);
      } else {
        dbg(
          debug,
          `Plus-assign => existing not object => overwriting => ${dottedKey}`,
        );
        setVal(obj, dottedKey, newVal, debug);
      }
      return;
    }

    if (typeof newVal === "string") {
      if (typeof existingVal === "string") {
        setVal(obj, dottedKey, existingVal + newVal, debug);
      } else {
        setVal(obj, dottedKey, newVal, debug);
      }
      return;
    }

    // fallback => override
    setVal(obj, dottedKey, newVal, debug);
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

// ----------------------------------------------------------------------
//  parseInlineValue + supporting functions
// ----------------------------------------------------------------------

function parseInlineValue(rawVal, baseDir, debug) {
  let val = rawVal.trim();

  // find top-level array or object blocks:
  const braceBlocks = extractTopLevelBlocks(val, "{", "}");
  const bracketBlocks = extractTopLevelBlocks(val, "[", "]");

  // multiple blocks => parse and merge
  if (braceBlocks.length + bracketBlocks.length > 1) {
    return parseMultipleBlocks(val, baseDir, debug);
  }

  // single bracket => parse array
  if (val.startsWith("[") && val.endsWith("]")) {
    return parseInlineArray(val, debug);
  }
  // single brace => parse object
  if (val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    return parseString(inner, baseDir, { debug });
  }

  // else => treat as string (with triple-quote or normal quotes, env, etc.)
  return resolveEnv(val, debug);
}

function parseMultipleBlocks(line, baseDir, debug) {
  dbg(debug, `parseMultipleBlocks => ${line}`);
  const tokens = [];
  let i = 0;

  while (i < line.length) {
    // skip whitespace
    while (i < line.length && /\s/.test(line[i])) i++;

    if (i >= line.length) break;

    let ch = line[i];
    if (ch === "[" || ch === "{") {
      const close = ch === "[" ? "]" : "}";
      let start = i;
      i++;
      let depth = 1;
      while (i < line.length && depth > 0) {
        if (line[i] === ch) depth++;
        else if (line[i] === close) depth--;
        i++;
      }
      const block = line.slice(start, i); // inclusive
      tokens.push(block.trim());
    } else {
      // gather until next brace/bracket or end
      let start = i;
      while (
        i < line.length &&
        line[i] !== "[" &&
        line[i] !== "]" &&
        line[i] !== "{" &&
        line[i] !== "}"
      ) {
        i++;
      }
      const text = line.slice(start, i).trim();
      if (text) tokens.push(text);
    }
  }

  dbg(debug, `parseMultipleBlocks => tokens=`, tokens);

  const parsedList = tokens.map((t) => {
    if (t.startsWith("[") && t.endsWith("]")) {
      return parseInlineArray(t, debug);
    } else if (t.startsWith("{") && t.endsWith("}")) {
      const inner = t.slice(1, -1).trim();
      return parseString(inner, baseDir, { debug });
    } else {
      return resolveEnv(t, debug);
    }
  });

  if (parsedList.every((x) => Array.isArray(x))) {
    dbg(debug, `parseMultipleBlocks => merging arrays`);
    return parsedList.reduce((acc, arr) => acc.concat(arr), []);
  }
  if (
    parsedList.every((x) => x && typeof x === "object" && !Array.isArray(x))
  ) {
    dbg(debug, `parseMultipleBlocks => merging objects`);
    return parsedList.reduce((acc, obj) => {
      mergeObjs(acc, obj, debug);
      return acc;
    }, {});
  }

  // fallback => single string
  dbg(debug, `parseMultipleBlocks => fallback => string concat`);
  return parsedList.map(String).join(" ");
}

function parseInlineArray(arrStr, debug) {
  dbg(debug, `parseInlineArray => ${arrStr}`);
  const inner = arrStr.slice(1, -1).trim();
  if (!inner) return [];
  // any env expansions that return undefined => array item is literally undefined
  // (which logs as [null] in JSON, but in memory it's [undefined])
  return inner
    .split(/[\s,]+/)
    .map((it) => it.trim())
    .filter(Boolean)
    .map((it) => resolveEnv(it, debug));
}

function extractTopLevelBlocks(str, startChar, endChar) {
  let blocks = [];
  let depth = 0;
  let startIndex = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === startChar) {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (str[i] === endChar) {
      depth--;
      if (depth === 0 && startIndex !== -1) {
        blocks.push(str.slice(startIndex, i + 1));
        startIndex = -1;
      }
    }
  }
  return blocks;
}

// ----------------------------------------------------------------------
//  Basic expansions
// ----------------------------------------------------------------------

function resolveEnv(raw, debug) {
  dbg(debug, `resolveEnv => ${raw}`);

  // triple quotes
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    let tripleInner = raw.slice(3, -3);
    tripleInner = tripleInner.replace(/\\n/g, "\n");
    dbg(debug, `Triple-quoted => returning multi-line value`);
    return tripleInner;
  }

  // normal quotes
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
    dbg(debug, `Stripped quotes => ${raw}`);
  }

  // ?VAR => ?FOO or ${?FOO}
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

  // fallback => as-is
  return raw;
}

// ----------------------------------------------------------------------
//  merges, setVal, getVal
// ----------------------------------------------------------------------

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
      if (v.length === 1 && (v[0] === undefined || v[0] === null)) {
        dbg(debug, `[undefined/null] => skip array override => key=${k}`);
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

// ----------------------------------------------------------------------
//  Utility
// ----------------------------------------------------------------------

function dbg(flag, ...args) {
  if (flag) console.debug(...args);
}

/**
 * preProcessHocon(content, debug):
 *   - merges multi-line arrays into a single line
 *   - merges triple-quoted strings into a single line
 *   so parseBlock can handle them with simpler logic.
 */
function preProcessHocon(content, debug) {
  const rawLines = content.split("\n");
  let out = [];
  let i = 0;

  while (i < rawLines.length) {
    let line = rawLines[i];
    i++;

    // triple-quoted
    if (line.includes('"""')) {
      let tripleStart = line.indexOf('"""');
      let fullLine = line;
      let searching = line.indexOf('"""', tripleStart + 3) === -1;
      while (searching && i < rawLines.length) {
        fullLine += "\\n" + rawLines[i];
        if (rawLines[i].includes('"""')) {
          searching = false;
        }
        i++;
      }
      out.push(fullLine);
      continue;
    }

    // gather multiline array
    if (line.includes("[") && !line.trim().endsWith("]")) {
      let merged = line;
      let bracketFound = line.includes("]");
      while (!bracketFound && i < rawLines.length) {
        merged += rawLines[i];
        if (rawLines[i].includes("]")) {
          bracketFound = true;
        }
        i++;
      }
      out.push(merged);
      continue;
    }

    out.push(line);
  }

  dbg(debug, "preProcess => final lines:\n", out.join("\n"));
  return out;
}

function buildEnvMap(env, prefix) {
  const map = {};
  for (const [key, val] of Object.entries(env)) {
    if (prefix) {
      if (!key.startsWith(prefix)) continue;
      const stripped = key.slice(prefix.length);
      map[stripped.replace(/_/g, ".")] = val;
    } else {
      map[key.replace(/_/g, ".")] = val;
    }
  }
  return map;
}

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

/**
 * Finally, your commit command:
 */
// git commit -a -m "Fix partial/undefined env skipping. Keep old if new is undefined/null or [undefined/null]. All tests pass now."
