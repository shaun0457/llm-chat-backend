/* eslint-env node */
// Test-only eslint-plugin-import resolver: resolves relative imports to the .ts path they name
// without requiring the file to exist, so zones can be tested for modules not written yet.
const path = require("node:path");

exports.interfaceVersion = 2;

exports.resolve = (source, file) => {
  if (!source.startsWith(".")) {
    return { found: false };
  }
  return { found: true, path: path.resolve(path.dirname(file), source.replace(/\.js$/, ".ts")) };
};
