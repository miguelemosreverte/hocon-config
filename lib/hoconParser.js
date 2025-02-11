const fs = require("fs");
const path = require("path");

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
 *   Reads a .conf file from disk. Merges includes (with required or optional),
 *   environment expansions, partial array logic, triple-quoted strings,
 *   multi-line arrays, fallback expansions, self references, typed numeric,
 *   while respecting quoted => string, etc.
 */
function parseFile(filePath, options = {}) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf8");
  return parseString(content, path.dirname(absPath), options);
}

/**
 * parseString(content, baseDir, [options]):
 *   Main parse from a string.  Does merges, expansions, includes, fallback, etc.
 */
function parseString(content, baseDir, options = {}) {
  const { debug = false, overrides = null } = options;

  dbg(debug, `parseString() baseDir=${baseDir || "."}, len=${content.length}`);

  let lines = preProcessHocon(content, debug);

  // remove empty / # / //
  lines = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  dbg(debug, `After preProcess, we have ${lines.length} lines`);

  let currentIndex = 0;
  const result = {};

  function parseBlock(parentObj) {
    while (currentIndex < lines.length) {
      const line = lines[currentIndex];
      dbg(debug, `Line ${currentIndex + 1}: ${line}`);

      if (line.startsWith("}")) {
        dbg(debug, "Block ends here");
        return;
      }

      // includes:  include "foo.conf" or include required("foo.conf")
      if (line.startsWith("include ")) {
        handleInclude(line, parentObj);
        currentIndex++;
        continue;
      }

      // single-line => key { ... }
      let match = line.match(/^([^=:]+?)\{\s*(.*?)\}\s*$/);
      if (match) {
        const key = match[1].trim();
        const inner = match[2].trim();
        const childObj = parseString(inner, baseDir, options);
        setVal(parentObj, key, childObj, debug);
        currentIndex++;
        continue;
      }

      // multi-line => key {
      match = line.match(/^([^=:]+?)\{\s*$/);
      if (match) {
        const key = match[1].trim();
        currentIndex++;
        const childObj = {};
        parseBlock(childObj);
        if (lines[currentIndex] && lines[currentIndex].startsWith("}")) {
          currentIndex++;
        }
        setVal(parentObj, key, childObj, debug);
        continue;
      }

      // plus-assign => key += ...
      match = line.match(/^(.+?)\s*\+=\s*(.+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        plusAssignValue(parentObj, dottedKey, rawVal);
        currentIndex++;
        continue;
      }

      // normal => key = ...
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

  // include logic => differentiate required vs optional
  function handleInclude(line, parentObj) {
    dbg(debug, `handleInclude => ${line}`);

    // e.g.:  include required("overrides.conf") or include "overrides.conf"
    // match optional:   include required("filename")
    // match plain:      include "filename"
    let requiredMatch = line.match(/^include\s+required\("(.+)"\)$/);
    if (requiredMatch) {
      let incFile = requiredMatch[1];
      let incPath = path.resolve(baseDir || ".", incFile);
      dbg(debug, `Include (required) => path=${incPath}`);
      if (!fs.existsSync(incPath)) {
        // file missing => throw
        throw new Error(
          `HOCON: Required include file missing => ${incPath}`
        );
      }
      let included = parseFile(incPath, options);
      dbg(debug, "Merging included =>", included);
      mergeObjs(parentObj, included, debug);
      return;
    }

    // plain optional =>  include "filename"
    let optionalMatch = line.match(/^include\s+"(.+)"$/);
    if (optionalMatch) {
      let incFile = optionalMatch[1];
      let incPath = path.resolve(baseDir || ".", incFile);
      dbg(debug, `Include (optional) => path=${incPath}`);
      if (!fs.existsSync(incPath)) {
        dbg(debug, `Optional include missing => skipping => ${incPath}`);
        return;
      }
      let included = parseFile(incPath, options);
      dbg(debug, "Merging included =>", included);
      mergeObjs(parentObj, included, debug);
      return;
    }

    // unknown pattern => skip or log
    dbg(debug, "Unknown include pattern => " + line);
  }

  function isUndefOrNull(x) {
    return x === undefined || x === null;
  }

  function assignValue(obj, dottedKey, rawVal) {
    const newVal = parseInlineValue(rawVal, baseDir, debug);
    const existingVal = getVal(obj, dottedKey);

    if (isUndefOrNull(newVal) && !isUndefOrNull(existingVal)) {
      dbg(debug, `Skipping undefined => keep old for ${dottedKey}`);
      return;
    }

    // partial array => [undefined] skip if existing is non-empty array
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      isUndefOrNull(newVal[0]) &&
      Array.isArray(existingVal) &&
      existingVal.length > 0
    ) {
      dbg(debug, `[undefined] => skip override => key=${dottedKey}`);
      return;
    }

    setVal(obj, dottedKey, newVal, debug);
  }

  function plusAssignValue(obj, dottedKey, rawVal) {
    const newVal = parseInlineValue(rawVal, baseDir, debug);
    const existingVal = getVal(obj, dottedKey);

    if (existingVal === undefined) {
      setVal(obj, dottedKey, newVal, debug);
      return;
    }
    if (isUndefOrNull(newVal)) {
      dbg(debug, `Skipping undefined => keep old for ${dottedKey}`);
      return;
    }
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      isUndefOrNull(newVal[0]) &&
      Array.isArray(existingVal) &&
      existingVal.length > 0
    ) {
      dbg(debug, `[undefined] => skip array override => key=${dottedKey}`);
      return;
    }

    // merges
    if (Array.isArray(newVal)) {
      if (Array.isArray(existingVal)) {
        setVal(obj, dottedKey, existingVal.concat(newVal), debug);
      } else {
        dbg(debug, `PlusAssign => existing not array => overwriting => ${dottedKey}`);
        setVal(obj, dottedKey, newVal, debug);
      }
      return;
    }

    if (newVal && typeof newVal === "object" && !Array.isArray(newVal)) {
      if (existingVal && typeof existingVal === "object" && !Array.isArray(existingVal)) {
        mergeObjs(existingVal, newVal, debug);
      } else {
        dbg(debug, `PlusAssign => existing not object => overwriting => ${dottedKey}`);
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

  // merges overrides last
  if (overrides && typeof overrides === "object") {
    dbg(debug, `Applying overrides => ${JSON.stringify(overrides)}`);
    for (const [k, v] of Object.entries(overrides)) {
      setVal(result, k, v, debug);
    }
  }

  // fallback expansions
  resolveFallbacks(result, debug);

  // references
  const visitedPaths = new WeakSet();
  resolveReferences(result, result, debug, visitedPaths);

  dbg(debug, "Done =>", JSON.stringify(result, null, 2));
  return result;
}

// fallback expansions => X or Y
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

// references => ${some.path}
function resolveReferences(configRoot, node, debug, visited) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = resolveReferences(configRoot, node[i], debug, visited);
    }
    return node;
  }
  if (node && typeof node === "object") {
    if (visited.has(node)) {
      dbg(debug, "Detected cycle => skip =>", node);
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
      let cloned = deepClone(val);
      cloned = resolveReferences(configRoot, cloned, debug, visited);
      return cloned;
    }

    for (const k of Object.keys(node)) {
      node[k] = resolveReferences(configRoot, node[k], debug, visited);
    }
    return node;
  }
  return node;
}

// parseInlineValue => parse unquoted => typed, quoted => keep as string, etc.
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

  return resolveEnvOrRef(val, debug);
}

function parseMultipleBlocks(line, baseDir, debug) {
  dbg(debug, `parseMultipleBlocks => ${line}`);
  const tokens = tokenizeLine(line, debug);

  // fallback => X or Y
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

  const parsedList = tokens.map((t) => parseSingleToken(t, baseDir, debug));

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

// typed expansions => parse numbers/booleans/null, or keep string if quoted
function resolveEnvOrRef(raw, debug) {
  dbg(debug, `resolveEnvOrRef => ${raw}`);

  // triple-quoted
  if (raw.startsWith('"""') && raw.endsWith('"""')) {
    let tripleInner = raw.slice(3, -3).replace(/\\n/g, "\n");
    dbg(debug, "Triple-quoted => returning multi-line value");
    return tripleInner;
  }

  let wasQuoted = false;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1);
    wasQuoted = true;
    dbg(debug, `Stripped quotes => ${raw}`);
  }

  // ?VAR => e.g. ?FOO
  let m = raw.match(/^\?([\w_]+)$/);
  if (m) {
    let envVar = safeEnvLookup(m[1], debug);
    dbg(debug, `?ENV => ${m[1]} => ${envVar}`);
    return wasQuoted
      ? (envVar === undefined ? undefined : String(envVar))
      : maybeConvertPrimitive(envVar, debug);
  }

  // ${?VAR}
  m = raw.match(/^\$\{\?([\w_]+)\}$/);
  if (m) {
    let envVar = safeEnvLookup(m[1], debug);
    dbg(debug, `CurlyENV => ${m[1]} => ${envVar}`);
    return wasQuoted
      ? (envVar === undefined ? undefined : String(envVar))
      : maybeConvertPrimitive(envVar, debug);
  }

  // ${some.path}
  m = raw.match(/^\$\{([\w.\-_]+)\}$/);
  if (m) {
    let refPath = m[1];
    dbg(debug, `Reference => path=${refPath}`);
    return {
      __type: "REF",
      path: refPath,
    };
  }

  // typed parse if not quoted
  if (wasQuoted) {
    return raw;
  }
  return maybeConvertPrimitive(raw, debug);
}

/**
 * safeEnvLookup => remove one layer of quotes from env
 */
function safeEnvLookup(key, debug) {
  let val = process.env[key];
  if (val == null) return val;
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    dbg(debug, `Stripping outer quotes from env var => ${val}`);
    val = val.slice(1, -1);
  }
  return val;
}

/**
 * maybeConvertPrimitive => parse booleans/null/numbers, except if "2.0" => keep "2.0" if parse becomes 2
 */
function maybeConvertPrimitive(str, debug) {
  if (str === undefined || str === null) return str;
  const raw = String(str).trim();

  // booleans
  if (/^(?i:true)$/.test(raw)) {
    dbg(debug, `Converted to boolean => true`);
    return true;
  }
  if (/^(?i:false)$/.test(raw)) {
    dbg(debug, `Converted to boolean => false`);
    return false;
  }
  // null
  if (/^(?i:null)$/.test(raw)) {
    dbg(debug, `Converted to null`);
    return null;
  }
  // numeric => check if valid float or int
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) {
    const num = parseFloat(raw);
    if (!Number.isNaN(num)) {
      // if raw has a decimal point => e.g. "2.0" => parseFloat => 2 => keep as string
      if (raw.includes('.') && Number.isInteger(num)) {
        dbg(debug, `Preserving decimal => keep string => ${raw}`);
        return raw;
      }
      dbg(debug, `Converted to number => ${num}`);
      return num;
    }
  }
  // else => string
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

// merges, setVal, getVal
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
  const rawParts = dottedKey.split(".");
  const parts = rawParts.filter((p) => p.length > 0);

  if (parts.length === 0) {
    dbg(debug, `Ignoring empty or all-dot key => val=${JSON.stringify(value)}`);
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

function getVal(obj, dottedKey) {
  const parts = dottedKey.split(".");
  let c = obj;
  for (const p of parts) {
    if (!c || typeof c !== "object") return undefined;
    c = c[p];
  }
  return c;
}

// debug helper
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

    // gather multiline arrays
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

// environment-based overrides
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

// CLI-based overrides => --some.key=val
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

