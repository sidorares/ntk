module.exports.listFontsSync = function(pattern) {
  var fmPattern = {};
  fmPattern.family = pattern.family;
  if (pattern.style.indexOf('italic') != -1) {
    fmPattern.italic = true;
  }
  if (pattern.weight == 'normal') {
    fmPattern.weight = 400;
  } else if (pattern.weight == 'bold') {
    fmPattern.weight = 700;
  } else if (!isNaN(parseInt(pattern.weight))) {
    fmPattern.weight = parseInt(pattern.weight);
  }

  var match = require('font-scanner').findFontSync(fmPattern);
  return match;
};
