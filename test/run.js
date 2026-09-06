#!/usr/bin/env node
// test/run.js
//
// Finds every test/*.test.js file, requires it, and runs each exported
// zero-arg function as one test. No framework: a test file is just an
// object of functions that throw (via assert) on failure.
var fs = require('fs');
var path = require('path');

var testDir = __dirname;
var files = fs.readdirSync(testDir).filter(function (name) {
  return (/\.test\.js$/).test(name);
}).sort();

var totalPass = 0;
var totalFail = 0;

files.forEach(function (file) {
  var mod = require(path.join(testDir, file));
  Object.keys(mod).forEach(function (testName) {
    try {
      mod[testName]();
      totalPass += 1;
      console.log('PASS  ' + file + ' - ' + testName);
    } catch (error) {
      totalFail += 1;
      console.log('FAIL  ' + file + ' - ' + testName + ' - ' + error.message);
    }
  });
});

console.log(totalPass + ' passed, ' + totalFail + ' failed.');
if (totalFail > 0) {
  process.exit(1);
}
