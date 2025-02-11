# hocon-config

[![CI Tests](https://github.com/miguelemosreverte/hocon-parser/actions/workflows/ci.yml/badge.svg)](https://github.com/miguelemosreverte/hocon-parser/actions)
[![npm version](https://img.shields.io/npm/v/hocon-config.svg)](https://www.npmjs.com/package/hocon-config)
[![License](https://img.shields.io/github/license/miguelemosreverte/hocon-parser.svg)](./LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/hocon-config.svg)](https://www.npmjs.com/package/hocon-config)

A **robust** HOCON (Human-Optimized Config Object Notation) parser and loader for Node.js. We **fully** handle:

- **Environment variable substitutions** (`?ENV_VAR` / `${?ENV_VAR}`)
- **Multiple-file includes** (`include "overrides.conf"`)
- **Nested objects** & **arrays** (with dotted keys → nested objects)
- **Merging** of keys (last definition always wins)
- **Partial array overrides** (with `[undefined]` skip logic)
- **Programmatic overrides** for advanced usage
- **Zero dependencies** – only Node built-ins
- **Jest**-based tests to ensure quality

No need to be humble: **`hocon-config`** is **powerful** yet straightforward, making your Node.js configuration a breeze.

---

## Installation

```bash
npm install hocon-config
```

Require or import it in your Node.js code. That’s it!

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

2. **Parse it**:
   ```js
   const path = require('path');
   const { parseFile } = require('hocon-config');

   const filePath = path.join(__dirname, 'config', 'base.conf');
   const config = parseFile(filePath);

   console.log(config);
   // Output might look like:
   // {
   //   app: { name: 'ExampleApp' },
   //   database: { host: 'localhost', port: 5432 }
   // }
   ```

3. **Done**. You now have a Node.js object ready for your app’s config needs.

---

## Usage

### Parsing a File

```js
const path = require('path');
const { parseFile } = require('hocon-config');

const config = parseFile(path.join(__dirname, 'config', 'base.conf'));
console.log(config);
```

- **Includes**: If `base.conf` has `include "overrides.conf"`, it merges that file’s contents too.
- **Merging**: If the same key is defined multiple times, the last definition “wins.”

### Parsing a String

```js
const { parseString } = require('hocon-config');

const hoconData = `
  server { port = 3000 }
  feature.enabled = ${'?FEATURE_FLAG'}
`;

process.env.FEATURE_FLAG = 'true';

const inlineConfig = parseString(hoconData, __dirname);
console.log(inlineConfig);
// => { server: { port: '3000' }, feature: { enabled: 'true' } }
```

The second argument (`__dirname`) is used for resolving any `include` statements within the string (relative paths).

### Environment Variable Substitution

A line like:
```hocon
someKey = ${?ENV_VAR}
```
- If `ENV_VAR` is set, `someKey` becomes that env value.
- If not, the parser keeps the old value or remains `undefined` if none existed before.

Example:
```hocon
someKey = "defaultValue"
someKey = ${?UNDEFINED_VAR}  # remains "defaultValue" if not set
```

### Multiple File Includes

Easily combine multiple files:
```hocon
# base.conf
app.name = "BaseApp"
include "overrides.conf"
```
```hocon
# overrides.conf
app.name = "OverriddenApp"
```
After parsing `base.conf`, `app.name` ends up **OverriddenApp**.

### Programmatic Overrides

You can pass **overrides** last:
```js
const { parseFile } = require('hocon-config');

const config = parseFile('config/base.conf', {
  overrides: {
    'database.port': 9999,
    'app.name': 'HardCodedOverride'
  }
});
```
No matter what the files say, these overrides take precedence.

---

## Examples

**Base & Overrides**:

```hocon
# config/base.conf
server.ports = [8080, 9090, 10000]
feature.enabled = ${?FEATURE_FLAG}

include "overrides.conf"
```

```hocon
# config/overrides.conf
server.ports = [${?APP_PORT}]
```

Usage:
```js
const path = require('path');
const { parseFile } = require('hocon-config');

process.env.APP_PORT = "7777";
process.env.FEATURE_FLAG = "true";

const configPath = path.join(__dirname, 'config', 'base.conf');
const finalConfig = parseFile(configPath);

console.log(finalConfig);
// {
//   server: { ports: [ '7777', '9090', '10000' ] },
//   feature: { enabled: 'true' }
// }
```
---


## License

[MIT](LICENSE)
