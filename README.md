# hocon-config

[![CI Tests](https://github.com/miguelemosreverte/hocon-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/miguelemosreverte/hocon-parser/actions)
[![npm version](https://img.shields.io/npm/v/hocon-config.svg)](https://www.npmjs.com/package/hocon-config)
[![License](https://img.shields.io/github/license/miguelemosreverte/hocon-parser.svg)](./LICENSE)

A **powerful** HOCON (Human-Optimized Config Object Notation) parser and loader for Node.js. We **fully** handle:

- **Environment variable substitutions** (`?ENV_VAR` / `${?ENV_VAR}`)
- **Multiple-file includes** (`include "overrides.conf"`)
- **Nested objects** & **arrays** (dotted keys → nested objects)
- **Key merging** (last definition wins, partial array overrides, etc.)
- **Programmatic overrides** for advanced usage
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

2. **Use the `parse`** function to load it:
   ```js
   const path = require('path');
   const { parse } = require('hocon-config');

   const filePath = path.join(__dirname, 'config', 'base.conf');
   const config = parse(filePath); // debug=false by default

   console.log(config);
   // Might print:
   // {
   //   app: { name: 'ExampleApp' },
   //   database: { host: 'localhost', port: 5432 }
   // }
   ```

3. **Done!** You have a Node.js object ready to use.

---

## 10 Scenarios (From Simple to Complex)

Below are **ten** progressively more advanced scenarios demonstrating the **`parse`** function. In each, we show how HOCON resolves merges, environment variables, includes, or overrides. By the end, you’ll see just how powerful `hocon-config` is for real-world configs!

### **Scenario 1**: A Simple Key-Value

**File**: `config/s1.conf`
```hocon
hello = "world"
```

**Code**:
```js
const path = require('path');
const { parse } = require('hocon-config');

const conf = parse(path.join(__dirname, 'config', 's1.conf'));
console.log(conf); 
// => { hello: 'world' }
```
Nothing fancy. Just key-value parsing.

---

### **Scenario 2**: A Nested Object

**File**: `config/s2.conf`
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
const conf = parse(path.join(__dirname, 'config', 's2.conf'));
console.log(conf);
// => {
//   app: {
//     name: 'Scenario2',
//     nested: { level: 'deep' }
//   }
// }
```
We see objects like `app.nested.level` become nested JS objects.

---

### **Scenario 3**: Arrays & Merging

**File**: `config/s3.conf`
```hocon
server.ports = [8080, 9090]
server.ports = [10000]
```
Because the **last definition** wins, the second line overwrites the array:

```js
const conf = parse(path.join(__dirname, 'config', 's3.conf'));
console.log(conf);
// => { server: { ports: [ '10000' ] } }
```
**Note**: If you want partial merging, you can do partial array overrides using environment expansions (`[${?VAR}]`) with skip logic.

---

### **Scenario 4**: Environment Variables

**File**: `config/s4.conf`
```hocon
feature.flag = false
feature.flag = ${?FEATURE_FLAG}
```
**Usage**:
```js
process.env.FEATURE_FLAG = 'true'; // or keep it unset
const conf = parse(path.join(__dirname, 'config', 's4.conf'));
console.log(conf);
// => { feature: { flag: 'true' } } if ENV is set
// => { feature: { flag: 'false' } } if ENV is not set
```
**`?ENV_VAR`** expansions let you override default values only if the environment variable is defined.

---

### **Scenario 5**: Parsing a String (no file)

You can pass raw HOCON text to `parseString`:
```js
const { parseString } = require('hocon-config');

const hoconData = `
  server { port = 3000 }
  feature.enabled = ${'?FEATURE_FLAG'}
`;

process.env.FEATURE_FLAG = 'true';
const conf = parseString(hoconData, __dirname);
console.log(conf);
// => { server: { port: '3000' }, feature: { enabled: 'true' } }
```
**`parseString(hocon, baseDir)`** is great for inline config or testing.

---

### **Scenario 6**: Multi-File Includes

**File**: `config/s6-base.conf`
```hocon
app.name = "Scenario6"
include "s6-overrides.conf"
```

**File**: `config/s6-overrides.conf`
```hocon
app.name = "OverriddenName"
```
**Usage**:
```js
const conf = parse(path.join(__dirname, 'config', 's6-base.conf'));
console.log(conf);
// => { app: { name: 'OverriddenName' } }
```
**Includes** let you spread config across multiple files.

---

### **Scenario 7**: Partial Array Overrides with `[undefined]`

If your overrides set `server.ports = [${?APP_PORT}]`, but `APP_PORT` isn’t set, we skip overwriting:

**File**: `config/s7-base.conf`
```hocon
server.ports = [8080, 9090, 10000]
```

**File**: `config/s7-override.conf`
```hocon
include "s7-base.conf"
server.ports = [${?APP_PORT}]
```

**Usage**:
```js
delete process.env.APP_PORT;
const conf1 = parse('config/s7-override.conf');
console.log(conf1.server.ports);
// => [ '8080', '9090', '10000' ] (unchanged)

process.env.APP_PORT = '9999';
const conf2 = parse('config/s7-override.conf');
console.log(conf2.server.ports);
// => [ '9999', '9090', '10000' ]
```

---

### **Scenario 8**: Programmatic Overrides

Sometimes you want **hard-coded** final values no matter what:

```js
const conf = parse('config/s8.conf', {
  debug: false, // or true for logs
  overrides: {
    'database.host': 'prod-db.internal',
    'app.enableBeta': true
  }
});
```
Whatever `s8.conf` says, these keys are **forced** at the end.

---

### **Scenario 9**: Multiple-level includes

**File**: `config/s9-base.conf`
```hocon
app {
  name = "NestedIncludes"
}
include "s9-mid.conf"
```
**File**: `config/s9-mid.conf`
```hocon
app {
  midKey = true
}
include "s9-leaf.conf"
```
**File**: `config/s9-leaf.conf`
```hocon
app.final = "leaf"
```
**Usage**:
```js
const conf = parse('config/s9-base.conf');
console.log(conf);
// => {
//   app: {
//     name: 'NestedIncludes',
//     midKey: 'true',
//     final: 'leaf'
//   }
// }
```
Merges all files in the correct order.

---

### **Scenario 10**: Combining CLI + ENV

Often you want to pass environment variables **and** CLI arguments. For a simple approach, use `parseRuntime(filePath, { parseEnv: true, parseArgs: true })`. But if you prefer the “pure library” approach, do something like:

```js
process.env.FEATURE_FLAG = 'false';
const [ , , argPort ] = process.argv;
const port = argPort || 8080;

const conf = parse('config/cli-env.conf', {
  overrides: {
    'server.port': port,                 // from CLI
    'feature.flag': process.env.FEATURE_FLAG
  }
});

console.log(conf);
```
Run with:
```bash
node index.js 9999
```
**Overridden** keys reflect both environment and CLI.  

---

## parseFile and parseString

- **`parseFile(filePath, options?)`**:
  - Loads a HOCON file (which can include other files).
  - Merges environment expansions, partial arrays, etc.
  - Optionally merges **`overrides`**.

- **`parseString(hoconData, baseDir, options?)`**:
  - Same logic, but from inline text.
  - Resolves includes relative to `baseDir`.

**`parse`** is simply a convenience calling **`parseFile(filePath, { debug: false })`** by default.

---

## License

[MIT](LICENSE)
