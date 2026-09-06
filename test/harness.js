// test/harness.js
//
// Loads src.js into a Node vm context alongside the smallest possible
// shim for the GAS globals the dry-run cli() commands (list/compile/
// hello/help) actually touch - Logger.log and HtmlService's single
// file-read call (see model.js's readModelHtml()). Fixture files are
// then run into that same context, not require()'d as CommonJS modules,
// because cli()'s discoverNodes() finds nodes by scanning globalThis -
// exactly like Apps Script's shared top-level-var scope - so a fixture
// only becomes visible to it by executing in the same vm context.
var vm = require('vm');
var fs = require('fs');
var path = require('path');

var LIB_PATH = path.join(__dirname, '..', 'src.js');
var FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadContext(fixtureFiles) {
  var sandbox = {
    console: console,
    Logger: { log: function () {} },
    HtmlService: {
      createHtmlOutputFromFile: function (name) {
        var content = fs.readFileSync(path.join(FIXTURES_DIR, name + '.html'), 'utf8');
        return { getContent: function () { return content; } };
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(LIB_PATH, 'utf8'), sandbox, { filename: 'src.js' });
  (fixtureFiles || []).forEach(function (fixturePath) {
    vm.runInContext(fs.readFileSync(fixturePath, 'utf8'), sandbox, { filename: fixturePath });
  });
  return sandbox;
}

module.exports = { loadContext: loadContext, FIXTURES_DIR: FIXTURES_DIR };
