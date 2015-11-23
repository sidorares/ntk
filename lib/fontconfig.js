var cp = require('child_process');

// wrapper around fc command line utilities
// until https://github.com/devongovett/font-manager is ready for node 4
module.exports.listFontsSync = function(pattern) {
  console.log(pattern);
  var match = require('font-manager').findFontSync(pattern);
  console.log(match);
  return match;
  /*
  var output = cp.execSync('fc-list -v "' + pattern + '"');
  var matches = output.toString().match(/file: "[^"]+/g);
  var results = [];
  if (matches) {
    matches.forEach(function(l) {
      var m = l.match(/file: "([^"]+)/);
      if (m && m[1]) {
        results.push({
          path: m[1]
        })
      }
    })
  }
  console.log('FC: === ', pattern, results);
  return results;
  */
};
