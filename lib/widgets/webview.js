var spawn = require('child_process').spawn;

module.exports = function(parentWindow, args, callback)
{
    var id;
    if (typeof parentWindow == 'number')
        id = parentWindow;
    else
        id = parentWindow.id;
    var child = spawn('surf', ['-x', '-e', id, args.url]);
    child.once('line', function(line) {
        var Window = parentWindow.constructor;
        args.id = parseInt(line);
        args.parent = parentWindow;
        var view = new Window(parentWindow.display, args);
        callback(null, view);
    });

    var outbuff = '';
    child.stdout.on('data', function(data) {
        outbuff += data.toString();
        console.log('Buff:', outbuff);
        var lines = outbuff.split('\n');
        console.log(lines);
        var i, line; 
        for (i = 0; i < lines.length - 1; ++i) {
           line = lines.shift();
           console.log('emitting: ', line);
           child.emit('line', line);
        }
        outbuff = lines.join('\n');
    });
}
