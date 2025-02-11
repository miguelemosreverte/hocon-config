const fs = require("fs");
const path = require("path");

/**
 * parse(filePath, [runtimeOptions]):
 *   1) Gather overrides from process.env + process.argv
 *   2) parseFile(...) with those overrides
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
 *   Reads .conf from disk, merges includes (optional vs. required),
 *   environment expansions, partial array logic, triple-quoted strings,
 *   multi-line arrays, fallback expansions, self references, dotted keys,
 *   typed booleans/null/numbers, plus `+=` merges for arrays & objects, etc.
 */
function parseFile(filePath, options = {}) {
  const absPath = path.resolve(filePath);
  const content = fs.readFileSync(absPath, "utf8");
  return parseString(content, path.dirname(absPath), options);
}

/**
 * parseString(content, baseDir, [options]):
 *   Main parse from a string with HOCON features
 */
function parseString(content, baseDir, options = {}) {
  const { debug = false, overrides = null } = options;

  dbg(debug, `parseString() baseDir=${baseDir || "."}, len=${content.length}`);

  // unify triple-quoted lines & multi-line arrays
  let lines = preProcessHocon(content, debug);

  // remove blank / comment lines
  lines = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  dbg(debug, `After preProcess, we have ${lines.length} lines`);

  let currentIndex = 0;
  const result = {};

  function parseBlock(parentObj) {
    while (currentIndex < lines.length) {
      let line = lines[currentIndex];
      dbg(debug, `Line ${currentIndex + 1}: ${line}`);

      if (line.startsWith("}")) {
        dbg(debug, "Block ends here");
        return;
      }

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
        const childObj = parseStringWithParent(
          inner,
          baseDir,
          options,
          parentObj,
        );
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
      // IMPORTANT: allow newlines in the "value" => ([\s\S]+)
      match = line.match(/^(.+?)\s*[=:]\s*([\s\S]+)$/);
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

  // includes => optional vs required
  function handleInclude(line, parentObj) {
    dbg(debug, `handleInclude => ${line}`);
    let reqMatch = line.match(/^include\s+required\("(.+)"\)$/);
    if (reqMatch) {
      let incFile = reqMatch[1];
      let incPath = path.resolve(baseDir || ".", incFile);
      if (!fs.existsSync(incPath)) {
        throw new Error(`HOCON: Required include file missing => ${incPath}`);
      }
      let included = parseFile(incPath, options);
      mergeObjs(parentObj, included, debug);
      return;
    }

    let optMatch = line.match(/^include\s+"(.+)"$/);
    if (optMatch) {
      let incFile = optMatch[1];
      let incPath = path.resolve(baseDir || ".", incFile);
      if (!fs.existsSync(incPath)) {
        dbg(debug, `Optional include missing => skip => ${incPath}`);
        return;
      }
      let included = parseFile(incPath, options);
      mergeObjs(parentObj, included, debug);
      return;
    }
    dbg(debug, `Unknown include => ${line}`);
  }

  function assignValue(obj, dottedKey, rawVal) {
    let newVal = parseInlineValue(rawVal, baseDir, debug, obj);
    let existingVal = getVal(obj, dottedKey);
    if (newVal == null && existingVal != null) {
      dbg(debug, `Skipping null/undefined => keep old => ${dottedKey}`);
      return;
    }
    // partial array => [undefined] => skip
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      newVal[0] == null &&
      Array.isArray(existingVal) &&
      existingVal.length > 0
    ) {
      dbg(debug, `[undefined] => skip => ${dottedKey}`);
      return;
    }
    setVal(obj, dottedKey, newVal, debug);
  }

  function plusAssignValue(obj, dottedKey, rawVal) {
    let newVal = parseInlineValue(rawVal, baseDir, debug, obj);
    let existingVal = getVal(obj, dottedKey);

    if (existingVal === undefined) {
      setVal(obj, dottedKey, newVal, debug);
      return;
    }
    if (newVal == null) {
      dbg(debug, `Skipping null => keep old => ${dottedKey}`);
      return;
    }
    if (
      Array.isArray(newVal) &&
      newVal.length === 1 &&
      newVal[0] == null &&
      Array.isArray(existingVal) &&
      existingVal.length > 0
    ) {
      dbg(debug, `[undefined] => skip => ${dottedKey}`);
      return;
    }

    if (Array.isArray(newVal)) {
      if (Array.isArray(existingVal)) {
        setVal(obj, dottedKey, existingVal.concat(newVal), debug);
      } else {
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

    setVal(obj, dottedKey, newVal, debug);
  }

  parseBlock(result);

  // apply overrides last
  if (overrides && typeof overrides === "object") {
    for (const [k, v] of Object.entries(overrides)) {
      setVal(result, k, v, debug);
    }
  }

  // fallback expansions => X or Y
  resolveFallbacks(result, debug);

  // references => final pass
  const visitedPaths = new WeakSet();
  resolveReferences(result, result, debug, visitedPaths);

  dbg(debug, "Done =>", JSON.stringify(result, null, 2));
  return result;
}

/**
 * parseStringWithParent => parse a sub-config but referencing an existing parentObj
 */
function parseStringWithParent(content, baseDir, options, parentObj) {
  const { debug = false } = options || {};
  let lines = preProcessHocon(content, debug);
  lines = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("//"));

  let currentIdx = 0;
  const subResult = {};

  function parseBlock(pObj) {
    while (currentIdx < lines.length) {
      let line = lines[currentIdx];
      dbg(debug, `Mini parse => ${line}`);

      if (line.startsWith("}")) return;

      let match = line.match(/^([^=:]+?)\{\s*(.*?)\}\s*$/);
      if (match) {
        const k = match[1].trim();
        const inner = match[2].trim();
        let cObj = parseStringWithParent(inner, baseDir, options, pObj);
        setVal(pObj, k, cObj, debug);
        currentIdx++;
        continue;
      }

      match = line.match(/^([^=:]+?)\{\s*$/);
      if (match) {
        const k = match[1].trim();
        currentIdx++;
        const cObj = {};
        parseBlock(cObj);
        if (lines[currentIdx] && lines[currentIdx].startsWith("}")) {
          currentIdx++;
        }
        setVal(pObj, k, cObj, debug);
        continue;
      }

      match = line.match(/^(.+?)\s*\+=\s*(.+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        let newVal = parseInlineValue(rawVal, baseDir, debug, pObj);
        let existingVal = getVal(pObj, dottedKey);
        plusAssignValueMini(pObj, dottedKey, existingVal, newVal);
        currentIdx++;
        continue;
      }

      // again, allow newlines => ([\s\S]+)
      match = line.match(/^(.+?)\s*[=:]\s*([\s\S]+)$/);
      if (match) {
        const dottedKey = match[1].trim();
        const rawVal = match[2].trim();
        let newVal = parseInlineValue(rawVal, baseDir, debug, pObj);
        setVal(pObj, dottedKey, newVal, debug);
        currentIdx++;
        continue;
      }

      currentIdx++;
    }
  }

  parseBlock(subResult);
  return subResult;
}

function plusAssignValueMini(obj, dottedKey, existingVal, newVal) {
  if (existingVal === undefined) {
    setVal(obj, dottedKey, newVal);
    return;
  }
  if (newVal == null) {
    return;
  }
  if (Array.isArray(newVal)) {
    if (Array.isArray(existingVal)) {
      setVal(obj, dottedKey, existingVal.concat(newVal));
    } else {
      setVal(obj, dottedKey, newVal);
    }
    return;
  }
  if (newVal && typeof newVal === "object" && !Array.isArray(newVal)) {
    if (
      existingVal &&
      typeof existingVal === "object" &&
      !Array.isArray(existingVal)
    ) {
      mergeObjs(existingVal, newVal);
    } else {
      setVal(obj, dottedKey, newVal);
    }
    return;
  }
  if (typeof newVal === "string") {
    if (typeof existingVal === "string") {
      setVal(obj, dottedKey, existingVal + newVal);
    } else {
      setVal(obj, dottedKey, newVal);
    }
    return;
  }
  setVal(obj, dottedKey, newVal);
}

/**
 * parseInlineValue => parse a single line value => might have multiple tokens => partial references
 */
function parseInlineValue(rawVal, baseDir, debug, parentObj) {
  let val = rawVal.trim();

  const braceBlocks = extractTopLevelBlocks(val, "{", "}");
  const bracketBlocks = extractTopLevelBlocks(val, "[", "]");

  if (braceBlocks.length + bracketBlocks.length > 1) {
    return parseMultipleBlocks(val, baseDir, debug, parentObj);
  }

  if (val.startsWith("[") && val.endsWith("]")) {
    return parseInlineArray(val, debug, parentObj);
  }
  if (val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    return parseStringWithParent(inner, baseDir, { debug }, parentObj);
  }

  return parseMultipleBlocks(val, baseDir, debug, parentObj);
}

/**
 * parseMultipleBlocks => fallback expansions (X or Y), merges, or string concat
 */
function parseMultipleBlocks(line, baseDir, debug, parentObj) {
  dbg(debug, `parseMultipleBlocks => ${line}`);
  let tokens = tokenizeLine(line, debug);

  if (tokens.length === 3 && tokens[1].toLowerCase() === "or") {
    let mainVal = parseSingleToken(tokens[0], baseDir, debug, parentObj);
    let fbVal = parseSingleToken(tokens[2], baseDir, debug, parentObj);
    return { __type: "FALLBACK", main: mainVal, fallback: fbVal };
  }

  if (tokens.length === 1) {
    return parseSingleToken(tokens[0], baseDir, debug, parentObj);
  }

  let parsedList = tokens.map((t) =>
    parseSingleToken(t, baseDir, debug, parentObj),
  );

  // partial reference resolution => if parentObj has it
  parsedList = parsedList.map((v) => {
    if (v && typeof v === "object" && v.__type === "REF" && v.path) {
      let partial = getVal(parentObj || {}, v.path);
      if (partial !== undefined) {
        return deepClone(partial);
      }
    }
    return v;
  });

  // if all arrays => merge
  if (parsedList.every((x) => Array.isArray(x))) {
    return parsedList.reduce((acc, arr) => acc.concat(arr), []);
  }
  // if all objects => merge
  if (
    parsedList.every(
      (x) =>
        x && typeof x === "object" && !Array.isArray(x) && x.__type !== "REF",
    )
  ) {
    let mergedObj = {};
    for (const objVal of parsedList) {
      mergeObjs(mergedObj, objVal, debug);
    }
    return mergedObj;
  }

  // else => string concat
  return parsedList
    .map((x) => {
      if (x && typeof x === "object" && x.__type === "REF") {
        return x.path; // fallback => path
      }
      return x == null ? "" : String(x);
    })
    .join(" ")
    .trim();
}

/**
 * parseSingleToken => bracket => array, brace => object, else => references/typed expansions
 */
function parseSingleToken(token, baseDir, debug, parentObj) {
  if (token.startsWith("[") && token.endsWith("]")) {
    return parseInlineArray(token, debug, parentObj);
  }
  if (token.startsWith("{") && token.endsWith("}")) {
    const inner = token.slice(1, -1).trim();
    return parseStringWithParent(inner, baseDir, { debug }, parentObj);
  }
  return resolveEnvOrRef(token, debug);
}

/**
 * tokenizeLine => recognizes quoted strings as single tokens
 */
function tokenizeLine(line, debug) {
  // Remove inline comments starting with '#'
  const hashIndex = line.indexOf("#");
  if (hashIndex >= 0) {
    line = line.slice(0, hashIndex).trim();
  }

  const tokens = [];
  let i = 0;
  const len = line.length;

  while (i < len) {
    // skip any leading whitespace
    while (i < len && /\s/.test(line[i])) i++;
    if (i >= len) break;

    const ch = line[i];

    // 1) If we see an opening bracket/brace at top-level
    if (ch === "[" || ch === "{") {
      const close = ch === "[" ? "]" : "}";
      let start = i;
      i++;
      let depth = 1;
      while (i < len && depth > 0) {
        if (line[i] === ch) depth++;
        else if (line[i] === close) depth--;
        i++;
      }
      tokens.push(line.slice(start, i).trim());
      continue;
    }

    // 2) If we see a reference:  ${
    if (ch === "$" && i + 1 < len && line[i + 1] === "{") {
      let start = i;
      i += 2; // skip '${'
      while (i < len && line[i] !== "}") {
        i++;
      }
      if (i < len && line[i] === "}") i++; // skip '}'
      tokens.push(line.slice(start, i).trim());
      continue;
    }

    // 3) If we see a quoted string, gather until the matching quote
    if (ch === "'" || ch === '"') {
      const quoteChar = ch;
      let start = i;
      i++; // skip the opening quote
      while (i < len && line[i] !== quoteChar) {
        i++;
      }
      if (i < len && line[i] === quoteChar) i++; // skip closing quote
      tokens.push(line.slice(start, i));
      continue;
    }

    // 4) Otherwise gather an unquoted "word"
    let start = i;
    while (
      i < len &&
      !/\s/.test(line[i]) &&
      line[i] !== "[" &&
      line[i] !== "]" &&
      line[i] !== "{" &&
      line[i] !== "}" &&
      !(line[i] === "$" && i + 1 < len && line[i + 1] === "{") &&
      line[i] !== "'" &&
      line[i] !== '"'
    ) {
      i++;
    }

    const word = line.slice(start, i).trim();
    if (word) {
      tokens.push(word);
    }
  }

  dbg(debug, "tokenizeLine =>", tokens);
  return tokens;
}

/**
 * parseInlineArray => "[10,20]" => typed expansions
 */
function parseInlineArray(arrStr, debug, parentObj) {
  dbg(debug, `parseInlineArray => ${arrStr}`);
  const inner = arrStr.slice(1, -1).trim();
  if (!inner) return [];
  let items = inner
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  let out = items
    .map((it) => resolveEnvOrRef(it, debug))
    .map((val) => {
      if (
        val &&
        typeof val === "object" &&
        val.__type === "REF" &&
        val.path &&
        parentObj
      ) {
        let partial = getVal(parentObj, val.path);
        if (partial !== undefined) return deepClone(partial);
      }
      return val;
    });
  return out;
}

/**
 * typed expansions => booleans, null, numeric => keep "2.0" if parse =>2
 * remove single/double quotes once, then triple quotes if any
 */
function resolveEnvOrRef(raw, debug) {
  dbg(debug, `resolveEnvOrRef => ${raw}`);

  // step 1) remove single or double quotes if present
  let out = removeOuterQuotes(raw);
  let wasQuoted = out.removed;
  let text = out.text;

  // step 2) if text starts/ends with triple quotes => remove them => interpret as multiline
  // (In this approach, we've already flattened triple quotes into real \n lines.)
  if (text.startsWith('"""') && text.endsWith('"""')) {
    return text.slice(3, -3);
  }

  // step 3) references => ?VAR, ${?VAR}, ${some.path}, typed expansions
  let m = text.match(/^\?([\w_]+)$/);
  if (m) {
    let envVar = safeEnvLookup(m[1], debug);
    return wasQuoted
      ? envVar == null
        ? envVar
        : String(envVar)
      : maybeConvertPrimitive(envVar, debug);
  }
  // ${?VAR}
  m = text.match(/^\$\{\?([\w_]+)\}$/);
  if (m) {
    let envVar = safeEnvLookup(m[1], debug);
    return wasQuoted
      ? envVar == null
        ? envVar
        : String(envVar)
      : maybeConvertPrimitive(envVar, debug);
  }
  // normal ref => ${some.path}
  m = text.match(/^\$\{([\w.\-_]+)\}$/);
  if (m) {
    return { __type: "REF", path: m[1] };
  }

  // if wasQuoted => final is string
  if (wasQuoted) {
    return text;
  }
  // else => typed expansions
  return maybeConvertPrimitive(text, debug);
}

/**
 * removeOuterQuotes => remove single or double quotes if raw starts/ends with them
 */
function removeOuterQuotes(raw) {
  if (!raw || raw.length < 2) return { text: raw, removed: false };
  let s = raw;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
    return { text: s, removed: true };
  }
  return { text: raw, removed: false };
}

/**
 * safeEnvLookup => remove outer quotes from env var
 */
function safeEnvLookup(key, debug) {
  let val = process.env[key];
  if (val == null) return val;
  let out = removeOuterQuotes(val);
  if (out.removed) {
    dbg(debug, `stripped env quotes => was=${val}, now=${out.text}`);
    return out.text;
  }
  return val;
}

/**
 * maybeConvertPrimitive => parse booleans, null, numeric => keep "2.0" if parse =>2
 */
function maybeConvertPrimitive(str, debug) {
  if (str == null) return str;
  const raw = String(str).trim();

  // Use /.../i for case-insensitive
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  if (/^null$/i.test(raw)) return null;

  // numeric check stays the same
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) {
    let num = parseFloat(raw);
    if (!Number.isNaN(num)) {
      if (raw.includes(".") && Number.isInteger(num)) {
        dbg(debug, `preserve "2.0" => not 2 => keep string => ${raw}`);
        return raw;
      }
      return num;
    }
  }
  return raw;
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
      let mainVal = resolveFallbacks(node.main, debug);
      let fbVal = resolveFallbacks(node.fallback, debug);
      return mainVal == null ? fbVal : mainVal;
    }
    for (const k of Object.keys(node)) {
      node[k] = resolveFallbacks(node[k], debug);
    }
  }
  return node;
}

// references => ${some.path}, cycle detection
function resolveReferences(configRoot, node, debug, visited) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      node[i] = resolveReferences(configRoot, node[i], debug, visited);
    }
    return node;
  }
  if (node && typeof node === "object") {
    if (visited.has(node)) {
      dbg(debug, `cycle => skip`, node);
      return node;
    }
    visited.add(node);

    if (node.__type === "REF" && node.path) {
      let val = getVal(configRoot, node.path);
      if (val === undefined) return undefined;
      let cloned = deepClone(val);
      return resolveReferences(configRoot, cloned, debug, visited);
    }

    for (const k of Object.keys(node)) {
      node[k] = resolveReferences(configRoot, node[k], debug, visited);
    }
    return node;
  }
  return node;
}

// merges, setVal, getVal
function mergeObjs(target, source, debug) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return source;
  }
  for (const [k, v] of Object.entries(source)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      target[k] &&
      typeof target[k] === "object" &&
      !Array.isArray(target[k])
    ) {
      mergeObjs(target[k], v, debug);
    } else if (Array.isArray(v) && Array.isArray(target[k])) {
      if (v.length === 1 && v[0] == null) {
        // partial skip
      } else if (v.length === 1 && v[0] !== undefined) {
        target[k][0] = v[0];
      } else {
        target[k] = v;
      }
    } else {
      target[k] = v;
    }
  }
  return target;
}
function setVal(obj, dottedKey, value, debug) {
  let parts = dottedKey.split(".").filter((p) => p.length > 0);
  if (!parts.length) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    let p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") {
      cur[p] = {};
    }
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}
function getVal(obj, dottedKey) {
  let parts = dottedKey.split(".");
  let c = obj;
  for (const p of parts) {
    if (!c || typeof c !== "object") return undefined;
    c = c[p];
  }
  return c;
}

function dbg(flag, ...args) {
  if (flag) console.debug(...args);
}
function deepClone(x) {
  if (Array.isArray(x)) {
    return x.map(deepClone);
  }
  if (x && typeof x === "object") {
    let copy = {};
    for (const [k, v] of Object.entries(x)) {
      copy[k] = deepClone(v);
    }
    return copy;
  }
  return x;
}

/**
 * preProcessHocon => convert triple-quoted text into a single line with \n
 */
function preProcessHocon(content, debug) {
  let rawLines = content.split("\n");
  let out = [];
  let i = 0;

  while (i < rawLines.length) {
    let line = rawLines[i];
    i++;

    // Detect start of triple quotes
    if (line.includes('"""')) {
      let tripleStart = line.indexOf('"""');
      // Everything before '"""' is a prefix (e.g. key = )
      let prefix = line.slice(0, tripleStart);

      // Gather lines (including current one after the quotes)
      let buffer = [];
      // The remainder of this first line *after* the triple quotes
      let remainder = line.slice(tripleStart + 3);

      buffer.push(remainder);
      let foundEnd = remainder.includes('"""');

      // Keep reading subsequent lines until we find another '"""'
      while (!foundEnd && i < rawLines.length) {
        let nextLine = rawLines[i];
        i++;
        buffer.push(nextLine);
        if (nextLine.includes('"""')) {
          foundEnd = true;
        }
      }

      // The last line might also contain the closing """
      // remove everything after that
      let lastLine = buffer[buffer.length - 1];
      let closeIdx = lastLine.indexOf('"""');
      if (closeIdx >= 0) {
        buffer[buffer.length - 1] = lastLine.slice(0, closeIdx);
      }

      // Join all buffered lines with a real newline
      const joined = buffer.join("\n");
      // Convert it into a normal quoted string => "Hello\nstuff"
      // We can safely JSON.stringify so that internal quotes get escaped
      const quoted = JSON.stringify(joined);

      // Build the final single line
      const newLine = prefix + quoted;
      out.push(newLine);
      continue;
    }

    // Multi-line arrays: if line contains '[' but not ends with ']'
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

// environment & CLI overrides
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
