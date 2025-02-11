// test/example.js
const path = require("path");
// Suppose your parser exports parseRuntime, parseFile, or parse
const { parseRuntime } = require("../lib/hoconParser");

const confPath = path.join(__dirname, "config", "example.conf");

// We assume parseRuntime merges environment variables & CLI args
const finalConfig = parseRuntime(confPath, {
  parseEnv: true, // read from process.env
  parseArgs: true, // read from process.argv
  debug: false,
});

// Print the final config as JSON
console.log(JSON.stringify(finalConfig, null, 2));
