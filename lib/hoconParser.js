const fs = require("fs");
const path = require("path");

/**
 * parse(filePath, [runtimeOptions]):
 *   1. Gather overrides from process.env + process.argv
 *   2. parseFile(...) with those overrides
 *
 * runtimeOptions:
 *   envPrefix?: string  (default "")
 *   parseEnv?: boolean  (default true)
 *   parseArgs?: boolean (default true)
 *   debug?: boolean
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

  // parse from disk
  return parseFile(filePath, {
    debug,
    overrides: finalOverrides,
  });
}

/**
 * parseFile(filePath, [options]):
 *   Reads a .conf file from disk, merges includes, environment expansions,
 *   partial array logic, triple-quoted strings, multi-line arrays,
 *   fallback expansions, self references, etc., plus overrides.
 */
function parseFile(filePath, options = {}) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf8");
  return parseString(content, path.dirname(absPath), options);
}

/**
 * parseString(content, baseDir, [options]):
 *   Parses raw HOCON content from a string, handles merges, expansions,
 *   fallback expansions, self references, dotted keys, etc.
 *
 *   options:
 *     debug?: boolean
 *     overrides?: Record<string, any>
 */
function parseString(content, baseDir, options = {}) {
  const { debug = false, overrides = null } = options;

  dbg(debug, `parseString() baseDir=${baseDir || "."}, len=${content.length}`);

  // 1) Preprocess (combine multi-line arrays & triple-quoted strings)
  let lines = preProcessHocon(content, debug);

  // 2) Filter out empty / # / // lines
  lines = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  dbg(debug, `After preProcess, we have ${lines.length} lines`);

  let currentIndex = 0;
  const result = {};

  // parseBlock: reads lines until '}' or end
  function parseBlock(parentObj) {
    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      dbg(debug, `Line ${currentIndex + 1}: ${line}`);

      // end of block?
      if (line.startsWith("}")) {
        dbg(debug, "Block ends here");
        return;
      }

      // include "somefile.conf"
      if (line.startsWith("include ")) {
        handleInclude(line, parentObj);
        currentIndex++;
        continue;
      }

      // single-line nested block => key { child=val }
      let match = line.match(/^([^=:]+?)\{\s*(.*?)\}\s*$/);
      if (match) {
        const key = match[1].trim();
        const inner = match[2].trim();
        const childObj = parseString(inner, baseDir, options);
        setVal(parentObj, key, childObj, debug);
        currentIndex++;
        continue;
      }

      // multi-line block => key {
      match = line.match(/^([^=:]+?)\{\s*$/);
      if (match) {
        const key = match[1].trim();
        currentIndex++;
        const childObj = {};
        parseBlock(childObj); // parse nested
        if (lines[currentIndex] && lines[currentIndex].startsWith("}")) {
          currentIndex++;
        }
        setVal(parentObj, key, childObj, debug);
        continue;
      }

      // plus-assign => key += val
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

  function isUndefOrNull(x) {
    return x === undefined || x === null;
  }

  function assignValue(obj, dottedKey, rawVal) {
    const newVal = parseInlineValue(rawVal, baseDir, debug);
    const existingVal = getVal(obj, dottedKey);

    // skip if newVal is undefined/null but existingVal is not
    if (isUndefOrNull(newVal) && !isUndefOrNull(existingVal)) {
      dbg(debug, `Skipping undefined/null => keep old for ${dottedKey}`);
      return;
    }

    // skip if partial array => [undefined] or [null]
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

    setVal(obj, dottedKey, newVal, debug);
  }

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

    // merges or override
    if (Array.isArray(newVal)) {
      if (Array.isArray(existingVal)) {
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

    if (newVal && typeof newVal === "object" && !Array.isArray(newVal)) {
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

  parseBlock(result);

  // apply overrides last
  if (overrides && typeof overrides === "object") {
    dbg(debug, `Applying overrides => ${JSON.stringify(overrides)}`);
    for (const [k, v] of Object.entries(overrides)) {
      setVal(result, k, v, debug);
    }
  }

  // 1) Resolve fallback expansions => ( X or Y )
  resolveFallbacks(result, debug);

  // 2) Resolve references => ( ${someKey} ) with cycle detection
  const visitedPaths = new WeakSet();
  resolveReferences(result, result, debug, visitedPaths);

  dbg(debug, "Done =>", JSON.stringify(result, null, 2));
  return result;
}

// ==================================================
// FALLBACK EXPANSIONS => X or Y
// ==================================================
function resolveFallbacks(node, debug) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = resolveFallbacks(node[i], debug);
    }
    return node;
  }
  if (node && typeof node === "object") {
    if (node.__type === "FALLBACK") {
      dbg(debug, "resolving fallback =>", node);
      let mainVal = resolveFallbacks(node.main, debug);
      let fbVal = resolveFallbacks(node.fallback, debug);
      if (mainVal === undefined || mainVal === null) {
        return fbVal;
      }
      return mainVal;
    }
    for (const k of Object.keys(node)) {
      node[k] = resolveFallbacks(node[k], debug);
    }
  }
  return node;
}

// ==================================================
// SELF REFERENCES => ${some.path}
// ==================================================
function resolveReferences(configRoot, node, debug, visited) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = resolveReferences(configRoot, node[i], debug, visited);
    }
    return node;
  }
  if (node && typeof node === "object") {
    if (visited.has(node)) {
      // cycle => skip
      dbg(debug, "Detected cycle => skipping reference resolution for", node);
      return node;
    }
    visited.add(node);

    if (node.__type === "REF" && node.path) {
      dbg(debug, `Found REF => path=${node.path}`);
      const val = getVal(configRoot, node.path);
      if (val === undefined) {
        dbg(debug, `Reference not found => ${node.path}`);
        return undefined;
      }
      // clone and recursively resolve inside the clone
      let clonedVal = deepClone(val);
      clonedVal = resolveReferences(configRoot, clonedVal, debug, visited);
      return clonedVal;
    }

    for (const k of Object.keys(node)) {
      node[k] = resolveReferences(configRoot, node[k], debug, visited);
    }
    return node;
  }
  return node;
}

// ==================================================
// parseInlineValue => single line value parse
// ==================================================
function parseInlineValue(rawVal, baseDir, debug) {
  let val = rawVal.trim();

  const braceBlocks = extractTopLevelBlocks(val, "{", "}");
  const bracketBlocks = extractTopLevelBlocks(val, "[", "]");

  if (braceBlocks.length + bracketBlocks.length > 1) {
    return parseMultipleBlocks(val, baseDir, debug);
  }

  if (val.startsWith("[") && val.endsWith("]")) {
    return parseInlineArray(val, debug);
  }
  if (val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    return parseString(inner, baseDir, { debug });
  }

  // fallback => normal string or reference
  return resolveEnvOrRef(val, debug);
}

function parseMultipleBlocks(line, baseDir, debug) {
  dbg(debug, `parseMultipleBlocks => ${line}`);
  const tokens = tokenizeLine(line, debug);

  // fallback pattern => X or Y
  if (tokens.length === 3 && tokens[1].toLowerCase() === "or") {
    dbg(debug, "Detected fallback =>", tokens);
    const mainVal = parseSingleToken(tokens[0], baseDir, debug);
    const fbVal = parseSingleToken(tokens[2], baseDir, debug);
    return {
      __type: "FALLBACK",
      main: mainVal,
      fallback: fbVal,
    };
  }

  // else parse each token => arrays, objects, references, strings
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

  // fallback => treat as single string (value concatenation)
  return parsedList.map(String).join(" ");
}

function parseSingleToken(token, baseDir, debug) {
  if (token.startsWith("[") && token.endsWith("]")) {
    return parseInlineArray(token, debug);
  }
  if (token.startsWith("{") && token.endsWith("}")) {
    const inner = token.slice(1, -1).trim();
    return parseString(inner, baseDir, { debug });
  }
  return resolveEnvOrRef(token, debug);
}

// ==================================================
// handle references & environment expansions
// ==================================================
function resolveEnvOrRef(raw, debug) {
  dbg(debug, `resolveEnvOrRef => ${raw}`);

  // triple-quoted => """..."""
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    let tripleInner = raw.slice(3, -3).replace(/\\n/g, "\n");
    dbg(debug, "Triple-quoted => returning multi-line value");
    return tripleInner;
  }

  // normal quotes => "foo" or 'foo'
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    let stripped = raw.slice(1, -1);
    dbg(debug, `Stripped quotes => ${stripped}`);
    raw = stripped;
  }

  // ?VAR => e.g. ?FOO
  let m = raw.match(/^\?([\w_]+)$/);
  if (m) {
    let envVar = process.env[m[1]];
    dbg(debug, `?ENV => ${m[1]} => ${envVar}`);
    return envVar;
  }

  // ${?VAR}
  m = raw.match(/^\$\{\?([\w_]+)\}$/);
  if (m) {
    let envVar = process.env[m[1]];
    dbg(debug, `CurlyENV => ${m[1]} => ${envVar}`);
    return envVar;
  }

  // ${some.path} => reference node
  m = raw.match(/^\$\{([\w.\-_]+)\}$/);
  if (m) {
    let refPath = m[1];
    dbg(debug, `Reference => path=${refPath}`);
    return {
      __type: "REF",
      path: refPath,
    };
  }

  // else => plain string
  return raw;
}

function parseInlineArray(arrStr, debug) {
  dbg(debug, `parseInlineArray => ${arrStr}`);
  const inner = arrStr.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(/[\s,]+/)
    .map((it) => it.trim())
    .filter(Boolean)
    .map((it) => resolveEnvOrRef(it, debug));
}

// ==================================================
// tokenizing line => separate bracket blocks, etc.
// ==================================================
function tokenizeLine(line, debug) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
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
      tokens.push(line.slice(start, i).trim());
    } else {
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

// ==================================================
// top-level blocks
// ==================================================
function extractTopLevelBlocks(str, startChar, endChar) {
  let blocks = [];
  let depth = 0;
  let startIndex = -1;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === startChar) {
      if (depth === 0) startIndex = i;
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

// ==================================================
// merges, setVal, getVal
// ==================================================
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

/**
 * setVal => dottedKey expansions (including multiple or empty segments).
 */
function setVal(obj, dottedKey, value, debug) {
  dbg(debug, `setVal => path=${dottedKey}, val=${JSON.stringify(value)}`);

  // Split the key on "."; skip empty segments in case of e.g. "some..weird..path"
  // or if the user typed "..." (which can happen).
  const rawParts = dottedKey.split(".");
  const parts = rawParts.filter((p) => p.length > 0);

  if (parts.length === 0) {
    dbg(
      debug,
      `setVal => ignoring empty or all-dot key => val=${JSON.stringify(value)}`,
    );
    return;
  }

  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") {
      dbg(debug, `Creating subobj => ${parts.slice(0, i + 1).join(".")}`);
      cur[p] = {};
    }
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  cur[last] = value;
}

/**
 * getVal => dottedKey expansions
 */
function getVal(obj, dottedKey) {
  const parts = dottedKey.split(".");
  let c = obj;
  for (const p of parts) {
    if (!c || typeof c !== "object") return undefined;
    c = c[p];
  }
  return c;
}

// ==================================================
// Utility
// ==================================================
function dbg(flag, ...args) {
  if (flag) console.debug(...args);
}

function deepClone(x) {
  if (Array.isArray(x)) {
    return x.map(deepClone);
  }
  if (x && typeof x === "object") {
    const res = {};
    for (const [k, v] of Object.entries(x)) {
      res[k] = deepClone(v);
    }
    return res;
  }
  return x;
}

/**
 * preProcessHocon(content):
 *   merges multi-line arrays into single lines,
 *   merges triple-quoted strings,
 *   so parseBlock can be simpler
 */
function preProcessHocon(content, debug) {
  const rawLines = content.split("\n");
  let out = [];
  let i = 0;

  while (i < rawLines.length) {
    let line = rawLines[i];
    i++;

    // gather triple-quoted
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

    // gather multiline arrays => up to closing bracket
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

// environment overrides => prefix + underscore => dotted
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

// CLI overrides => --some.key=val
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
