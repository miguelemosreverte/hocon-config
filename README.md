# hocon-config

[![CI Tests](https://github.com/miguelemosreverte/hocon-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/miguelemosreverte/hocon-parser/actions)
[![npm version](https://img.shields.io/npm/v/hocon-config.svg)](https://www.npmjs.com/package/hocon-config)
[![License](https://img.shields.io/github/license/miguelemosreverte/hocon-parser.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/hocon-config.svg)](https://www.npmjs.com/package/hocon-config)

A **powerful** HOCON (Human-Optimized Config Object Notation) parser and loader for Node.js. We **fully** handle:

- **Environment variable substitutions** (`?ENV_VAR` / `${?ENV_VAR}`)
- **Multiple-file includes** (`include "overrides.conf"`)
- **Nested objects** & **arrays** (dotted keys → nested objects)
- **Key merging** (last definition wins, partial array overrides, etc.)
- **Programmatic overrides** for advanced usage
- **Built-in** CLI + ENV merging in the `parse` function
- **Zero dependencies** – only Node’s built-ins
- **Jest**-based tests ensuring quality

No need to be humble: **`hocon-config`** is **robust** yet straightforward, making your Node.js configuration a breeze.

---

## Installation

```bash
npm install hocon-config
```

Once installed, you can simply import or require it in your Node.js code.

---

## Quick Start

1. **Create a HOCON file** (e.g., `config/base.conf`):
   ```hocon
   app.name = "ExampleApp"
   database {
     host = "localhost"
     port = 5432
   }
   ```

2. **Use the `parse` function** to load it, automatically merging environment variables & CLI arguments:
   ```js
   const path = require('path');
   const { parse } = require('hocon-config');

   // Suppose we want to read config/base.conf
   // We'll pass no options => parseEnv=true, parseArgs=true, envPrefix=''
   const filePath = path.join(__dirname, 'config', 'base.conf');
   const config = parse(filePath);

   console.log(config);
   // Might print:
   // {
   //   app: { name: 'ExampleApp' },
   //   database: { host: 'localhost', port: 5432 }
   // }
   ```

3. **Done!** You have a Node.js object ready to use, and if you define environment variables or pass CLI arguments (prefixed keys, etc.), they override the config automatically.

---

## The `parse` Function

```js
/**
 * parse(filePath, [runtimeOptions]):
 * 1) Gather overrides from process.env + process.argv
 * 2) parseFile(...) with those overrides
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

  // Collect env-based overrides (keys with prefix => dottedKey)
  let envMap = {};
  if (parseEnv) envMap = buildEnvMap(process.env, envPrefix);

  // Collect CLI-based overrides (--app.name=Override)
  let argMap = {};
  if (parseArgs) {
    const argv = process.argv.slice(2);
    argMap = buildArgMap(argv);
  }

  // CLI overrides env if there's a conflict
  const finalOverrides = { ...envMap, ...argMap };

  // parseFile with final overrides
  return parseFile(filePath, {
    debug,
    overrides: finalOverrides,
  });
}
```

By default:
- **`envPrefix=""`** ensures only environment variables like `app_name` → `'app.name'` are considered.  
- **`parseEnv=true`** merges environment variables.  
- **`parseArgs=true`** merges CLI arguments of the form `--some.dotted.key=value`.  
- The final config merges these on top of your HOCON file’s contents.

---

## Usage & Examples

Below are **11 scenarios** from simple key-values to complex multi-file merges, environment usage, CLI arguments with nested keys, etc.

### **Scenario 1**: Simple Key-Value

**`config/s1.conf`**:
```hocon
hello = "world"
```
**Code**:
```js
const conf = parse('config/s1.conf');
console.log(conf);
// => { hello: 'world' }
```
Nothing fancy.

---

### **Scenario 2**: Nested Object

**`config/s2.conf`**:
```hocon
app {
  name = "Scenario2"
  nested {
    level = "deep"
  }
}
```
**Code**:
```js
const conf = parse('config/s2.conf');
console.log(conf);
// => {
//   app: {
//     name: 'Scenario2',
//     nested: { level: 'deep' }
//   }
// }
```
Objects like `app.nested.level` become nested JS objects.

---

### **Scenario 3**: Arrays & Merging

**`config/s3.conf`**:
```hocon
server.ports = [8080, 9090]
server.ports = [10000]
```
**Code**:
```js
const conf = parse('config/s3.conf');
console.log(conf);
// => { server: { ports: [ '10000' ] } }
```
The second line overwrote the entire array—**last definition wins**.

---

### **Scenario 4**: Environment Variables

**`config/s4.conf`**:
```hocon
feature.flag = false
feature.flag = ${?FEATURE_FLAG}
```
**Code**:
```js
process.env.FEATURE_FLAG = 'true';
const conf = parse('config/s4.conf');
console.log(conf);
// => { feature: { flag: 'true' } }
```

---

### **Scenario 5**: Partial Array Overwrites

**`config/s5-base.conf`**:
```hocon
server.ports = [8080, 9090, 10000]
```
**`config/s5-override.conf`**:
```hocon
include "s5-base.conf"
server.ports = [${?APP_PORT}]
```
**Usage**:
```js
delete process.env.APP_PORT;
const conf1 = parse('config/s5-override.conf');
console.log(conf1.server.ports);
// => [ '8080', '9090', '10000' ] (unchanged)

process.env.APP_PORT = '9999';
const conf2 = parse('config/s5-override.conf');
console.log(conf2.server.ports);
// => [ '9999', '9090', '10000' ]
```
If `$APP_PORT` isn’t defined, we skip overwriting the array.

---

### **Scenario 6**: Simple CLI Override

**`config/s6.conf`**:
```hocon
app.name = "BaseCLI"
server.port = 3000
```
**CLI**:
```bash
node index.js --app.name=MyCLIoverride --server.port=9999
```
**Code** (`index.js`):
```js
const conf = parse('config/s6.conf');
// => merges env vars w/ prefix '' plus CLI
console.log(conf);
// => { app: { name: 'MyCLIoverride' }, server: { port: '9999' } }
```
**`parse`** sees `--app.name=MyCLIoverride` → `{'app.name': 'MyCLIoverride'}`, overshadowing file definitions.

---

### **Scenario 7**: Multi-file Includes

**`config/s7-base.conf`**:
```hocon
app {
  name = "Scenario7"
}
include "s7-mid.conf"
```
**`config/s7-mid.conf`**:
```hocon
app.midKey = true
include "s7-leaf.conf"
```
**`config/s7-leaf.conf`**:
```hocon
app.final = "leaf"
```
**Code**:
```js
const conf = parse('config/s7-base.conf');
console.log(conf);
// => {
//   app: {
//     name: 'Scenario7',
//     midKey: 'true',
//     final: 'leaf'
//   }
// }
```
All merges happen in correct order.

---

### **Scenario 8**: Programmatic Overrides

```js
process.env.FEATURE_FLAG = 'false';
const conf = parse('config/s8.conf', {
  // override everything, if we want
  overrides: {
    'database.host': 'prod-db.internal',
    'app.enableBeta': true
  }
});
console.log(conf);
// merges file + env + CLI + final overrides
```
**Any** `overrides` object merges last, overshadowing everything else.

---

### **Scenario 9**: Combining Env + CLI + Hard Overrides

**`config/s9.conf`**:
```hocon
app.name = "BaseEnvCLI"
app.debug = false
```
**CLI**:
```bash
node index.js --app.debug=true
```
**Code**:
```js
process.env.app_name = 'EnvOverride'; 
const conf = parse('config/s9.conf', {
  overrides: { 'app.logLevel': 'VERBOSE' }
});
// Priority order (lowest -> highest):
// 1) file  => app.name=BaseEnvCLI, app.debug=false
// 2) env   => app.name=EnvOverride
// 3) CLI   => app.debug=true
// 4) overrides => app.logLevel=VERBOSE
console.log(conf);
// => {
//   app: {
//     name: 'EnvOverride',
//     debug: 'true',
//     logLevel: 'VERBOSE'
//   }
// }
```

---

### **Scenario 10**: Parsing a String Instead of a File

```js
const { parseString } = require('hocon-config');

const hoconData = `
  server { port = 3000 }
  feature.enabled = ${'?FEATURE_FLAG'}
`;

process.env.FEATURE_FLAG = 'true';
const inlineConfig = parseString(hoconData, __dirname, { debug: true });
console.log(inlineConfig);
// => { server: { port: '3000' }, feature: { enabled: 'true' } }
```
**No file** needed, just inline usage.

---

### **Scenario 11**: CLI Nested Dotted Keys

**`config/s11.conf`**:
```hocon
app {
  nestedKey = "original"
}
```
**CLI**:
```bash
node index.js --app.nestedKey=CLIOverride
```
**Code**:
```js
// parse() sees envPrefix '' for env, and parseArgs for CLI
const conf = parse('config/s11.conf');
console.log(conf);
// => { app: { nestedKey: 'CLIOverride' } }
```
**`parse`** automatically reads `process.argv` → `--app.nestedKey=CLIOverride` => `{'app.nestedKey': 'CLIOverride'}` overshadowing the file definition.

---

## `parseFile` and `parseString`

- **`parseFile(filePath, options?)`**:  
  Loads from a HOCON file, merges environment expansions, partial array merges, includes, plus optional `overrides`. Typically used behind the scenes by the simpler `parse(filePath, runtimeOptions)`.
- **`parseString(hocon, baseDir, options?)`**:  
  Same logic, just from inline text. Great for dynamic or test configs.

The star of the show is **`parse(filePath, runtimeOptions?)`**, which merges environment & CLI arguments automatically so your config can be manipulated by external factors with zero extra code.

---

## License

[MIT](LICENSE)