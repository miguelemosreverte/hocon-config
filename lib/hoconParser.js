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
 *   partial array logic, triple-quoted strings, multi-line arrays, `+=` merges,
 *   fallback expansions, plus any programmatic overrides.
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
 *   fallback expansions, plus optional overrides.
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

  // ---------------------------------------------------------
  // parseBlock: reads lines until '}' or end, populating parentObj
  // ---------------------------------------------------------
  function parseBlock(parentObj) {
    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      dbg(debug, `Line ${currentIndex + 1}: ${line}`);

      // End of block?
      if (line.startsWith("}")) {
        dbg(debug, "Block ends here");
        return;
      }

      // include "foo.conf"
      if (line.startsWith("include ")) {
        handleInclude(line, parentObj);
        currentIndex++;
        continue;
      }

      // Single-line nested block => key { child = val }
      let match = line.match(/^([^=:]+?)\{\s*(.*?)\}\s*$/);
      if (match) {
        const key = match[1].trim();
        const inner = match[2].trim();
        const childObj = parseString(inner, baseDir, options);
        setVal(parentObj, key, childObj, debug);
        currentIndex++;
        continue;
      }

      // Multi-line block => key {
      match = line.match(/^([^=:]+?)\{\s*$/);
      if (match) {
        const key = match[1].trim();
        currentIndex++;
        const childObj = {};
        parseBlock(childObj); // parse nested lines
        if (lines[currentIndex] && lines[currentIndex].startsWith("}")) {
          currentIndex++;
        }
        setVal(parentObj, key, childObj, debug);
        continue;
      }

      // plus-assign => key += value
      match = line.match(/^(.+?)\s*\+=\s*(.+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        plusAssignValue(parentObj, dottedKey, rawVal);
        currentIndex++;
        continue;
      }

      // normal key = value
      match = line.match(/^(.+?)\s*[=:]\s*(.+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        assignValue(parentObj, dottedKey, rawVal);
        currentIndex++;
        continue;
      }

      dbg(debug, "No pattern matched, skipping line");
      currentIndex++;
    }
  }

  // ---------------------------------------------------------
  // handleInclude
  // ---------------------------------------------------------
  function handleInclude(line, parentObj) {
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

  // ---------------------------------------------------------
  // isUndefOrNull helper
  // ---------------------------------------------------------
  function isUndefOrNull(x) {
    return x === undefined || x === null;
  }

  // ---------------------------------------------------------
  // assignValue => key = rawVal
  //   - skip if newVal is undefined/null or partial [undefined]
  // ---------------------------------------------------------
  function assignValue(obj, dottedKey, rawVal) {
    const newVal = parseInlineValue(rawVal, baseDir, debug);
    const existingVal = getVal(obj, dottedKey);

    // skip if strictly undefined/null
    if (isUndefOrNull(newVal) && !isUndefOrNull(existingVal)) {
      dbg(debug, `Skipping undefined/null => keep old for ${dottedKey}`);
      return;
    }

    // skip if partial array => [undefined/null]
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      isUndefOrNull(newVal[0]) &&
      Array.isArray(existingVal) &&
      existingVal.length > 0
    ) {
      dbg(debug, `[undefined/null] => skip override => key=${dottedKey}`);
      return;
    }

    // otherwise set
    setVal(obj, dottedKey, newVal, debug);
  }

  // ---------------------------------------------------------
  // plusAssignValue => key += rawVal
  // ---------------------------------------------------------
  function plusAssignValue(obj, dottedKey, rawVal) {
    const newVal = parseInlineValue(rawVal, baseDir, debug);
    const existingVal = getVal(obj, dottedKey);

    // if no existing => just set
    if (existingVal === undefined) {
      setVal(obj, dottedKey, newVal, debug);
      return;
    }

    // skip if newVal is undefined/null
    if (isUndefOrNull(newVal)) {
      dbg(debug, `Skipping undefined/null => keep old for ${dottedKey}`);
      return;
    }

    // skip if partial array => [undefined/null]
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      isUndefOrNull(newVal[0]) &&
      Array.isArray(existingVal) &&
      existingVal.length > 0
    ) {
      dbg(debug, `[undefined/null] => skip array override => key=${dottedKey}`);
      return;
    }

    // merges or overrides
    if (Array.isArray(newVal)) {
      if (Array.isArray(existingVal)) {
        setVal(obj, dottedKey, existingVal.concat(newVal), debug);
      } else {
        dbg(debug, `Plus-assign => existing not array => overwriting => ${dottedKey}`);
        setVal(obj, dottedKey, newVal, debug);
      }
      return;
    }

    if (newVal && typeof newVal === "object" && !Array.isArray(newVal)) {
      if (existingVal && typeof existingVal === "object" && !Array.isArray(existingVal)) {
        mergeObjs(existingVal, newVal, debug);
      } else {
        dbg(debug, `Plus-assign => existing not object => overwriting => ${dottedKey}`);
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

  // ---------------------------------------------------------
  // parse top-level
  // ---------------------------------------------------------
  parseBlock(result);

  // ---------------------------------------------------------
  // Apply overrides last
  // ---------------------------------------------------------
  if (overrides && typeof overrides === "object") {
    dbg(debug, `Applying overrides => ${JSON.stringify(overrides)}`);
    for (const [k, v] of Object.entries(overrides)) {
      setVal(result, k, v, debug);
    }
  }

  // ---------------------------------------------------------
  // NEW STEP: resolveFallbacks => handle "X or Y" logic
  // ---------------------------------------------------------
  resolveFallbacks(result, debug);

  dbg(debug, "Done =>", JSON.stringify(result, null, 2));
  return result;
}

// ======================================================================
//   FALLBACK EXPANSIONS (the "or" logic)
// ======================================================================

/**
 * resolveFallbacks(root):
 *   Recursively scans the entire object/array tree.
 *   If it finds { __type: "FALLBACK", main, fallback },
 *   it replaces that node with either `main` or `fallback` (if main is undefined/null).
 */
function resolveFallbacks(node, debug) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = resolveFallbacks(node[i], debug);
    }
    return node;
  }
  if (node && typeof node === "object") {
    // if it's a fallback node
    if (node.__type === "FALLBACK") {
      dbg(debug, "resolving fallback node =>", node);
      // main vs fallback
      const mainVal = resolveFallbacks(node.main, debug);
      const fallbackVal = resolveFallbacks(node.fallback, debug);
      if (mainVal === undefined || mainVal === null) {
        return fallbackVal;
      }
      return mainVal;
    }
    // else normal object => scan each key
    for (const k of Object.keys(node)) {
      node[k] = resolveFallbacks(node[k], debug);
    }
    return node;
  }
  // primitive => return as is
  return node;
}

// ======================================================================
//   PARSING INLINE VALUES (arrays, objects, merges, fallback tokens)
// ======================================================================

function parseInlineValue(rawVal, baseDir, debug) {
  let val = rawVal.trim();
  // detect top-level blocks
  const braceBlocks = extractTopLevelBlocks(val, "{", "}");
  const bracketBlocks = extractTopLevelBlocks(val, "[", "]");

  // if multiple blocks => parse & merge ( arrays or objects, or fallback detection )
  if (braceBlocks.length + bracketBlocks.length > 1) {
    return parseMultipleBlocks(val, baseDir, debug);
  }

  // single array?
  if (val.startsWith("[") && val.endsWith("]")) {
    return parseInlineArray(val, debug);
  }
  // single object?
  if (val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    return parseString(inner, baseDir, { debug });
  }

  // fallback => normal env/quote expansions
  return resolveEnv(val, debug);
}

/**
 * parseMultipleBlocks(line):
 *   Splits a line into tokens that might be arrays `[1,2]`, objects `{x=1}`,
 *   or text. If we see an EXACT pattern:  X, "or", Y  => build a fallback node.
 *   Otherwise, merge arrays, merge objects, or string concat.
 */
function parseMultipleBlocks(line, baseDir, debug) {
  dbg(debug, `parseMultipleBlocks => ${line}`);
  const tokens = tokenizeLine(line, debug);

  // detect EXACT pattern X or Y => fallback node
  if (tokens.length === 3 && tokens[1].toLowerCase() === "or") {
    dbg(debug, "Detected fallback pattern =>", tokens);
    const mainVal = parseSingleToken(tokens[0], baseDir, debug);
    const fallbackVal = parseSingleToken(tokens[2], baseDir, debug);
    return {
      __type: "FALLBACK",
      main: mainVal,
      fallback: fallbackVal,
    };
  }

  // else parse each token => arrays, objects, strings
  const parsedList = tokens.map((t) => parseSingleToken(t, baseDir, debug));

  // if all arrays => merge
  if (parsedList.every((x) => Array.isArray(x))) {
    dbg(debug, `parseMultipleBlocks => merging arrays`);
    return parsedList.reduce((acc, arr) => acc.concat(arr), []);
  }
  // if all objects => merge
  if (
    parsedList.every((x) => x && typeof x === "object" && !Array.isArray(x))
  ) {
    dbg(debug, `parseMultipleBlocks => merging objects`);
    return parsedList.reduce((acc, obj) => {
      mergeObjs(acc, obj, debug);
      return acc;
    }, {});
  }

  // fallback => single string concat
  dbg(debug, `parseMultipleBlocks => fallback => string concat`);
  return parsedList.map(String).join(" ");
}

/**
 * parseSingleToken:
 *   If token is an array "[..]", parse array.
 *   If token is an object "{..}", parse object.
 *   Else => string/env expansions
 */
function parseSingleToken(token, baseDir, debug) {
  if (token.startsWith("[") && token.endsWith("]")) {
    return parseInlineArray(token, debug);
  }
  if (token.startsWith("{") && token.endsWith("}")) {
    const inner = token.slice(1, -1).trim();
    return parseString(inner, baseDir, { debug });
  }
  // fallback => normal string / env
  return resolveEnv(token, debug);
}

/**
 * tokenizeLine(line):
 *   Splits a line into tokens (array/object blocks vs text).
 *   We do not handle nested { { ... } } here, but enough for typical HOCON lines.
 */
function tokenizeLine(line, debug) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    // skip whitespace
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;

    let ch = line[i];
    if (ch === "[" || ch === "{") {
      const close = (ch === "[") ? "]" : "}";
      let start = i;
      i++;
      let depth = 1;
      while (i < line.length && depth > 0) {
        if (line[i] === ch) depth++;
        else if (line[i] === close) depth--;
        i++;
      }
      const block = line.slice(start, i);
      tokens.push(block.trim());
    } else {
      // gather until whitespace or next brace
      let start = i;
      while (
        i < line.length &&
        !/\s/.test(line[i]) &&
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
  dbg(debug, "tokenizeLine =>", tokens);
  return tokens;
}

function parseInlineArray(arrStr, debug) {
  dbg(debug, `parseInlineArray => ${arrStr}`);
  const inner = arrStr.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(/[\s,]+/)
    .map((it) => it.trim())
    .filter(Boolean)
    .map((it) => resolveEnv(it, debug));
}

/**
 * extractTopLevelBlocks:
 *   Used to see how many {..} or [..] blocks are in a single line,
 *   ignoring nested braces for typical usage.
 */
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

// ======================================================================
//   Environment expansions & triple-quoted strings
// ======================================================================

function resolveEnv(raw, debug) {
  dbg(debug, `resolveEnv => ${raw}`);

  // triple-quoted => """..."""
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    let tripleInner = raw.slice(3, -3);
    tripleInner = tripleInner.replace(/\\n/g, "\n");
    dbg(debug, "Triple-quoted => returning multi-line value");
    return tripleInner;
  }

  // normal quotes => "foo" or 'foo'
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
    dbg(debug, `Stripped quotes => ${raw}`);
  }

  // ?VAR => ?FOO
  let m = raw.match(/^\?([\w_]+)$/);
  if (m) {
    let envVar = process.env[m[1]];
    dbg(debug, `?ENV => ${m[1]} => ${envVar}`);
    return envVar;
  }

  // ${?FOO}
  m = raw.match(/^\$\{\?([\w_]+)\}$/);
  if (m) {
    let envVar = process.env[m[1]];
    dbg(debug, `CurlyENV => ${m[1]} => ${envVar}`);
    return envVar;
  }

  // else => return as is
  return raw;
}

// ======================================================================
//   Merging, setVal, getVal
// ======================================================================

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
      // partial array skip => [undefined/null]
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

// ======================================================================
//   Misc Helpers
// ======================================================================

function dbg(flag, ...args) {
  if (flag) console.debug(...args);
}

/**
 * preProcessHocon(content, debug):
 *   merges multi-line arrays into one line,
 *   merges triple-quoted strings into one line, etc.
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

    // gather multiline array => lines until we find matching "]"
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

// Export the main parse API
module.exports = {
  parse,
  parseFile,
  parseString,
};
