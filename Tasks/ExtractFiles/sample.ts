/// <reference path="../../definitions/vsts-task-lib.d.ts" />
import tl = require('vsts-task-lib/task');


var path = require('path');

var echo = tl.createToolRunner(tl.which('echo', true));

var msg = tl.getInput('msg', true);
echo.arg(msg);
echo.arg("ts version 2");

var cwd = tl.getPathInput('cwd', false);

// will error and fail task if it doesn't exist
tl.checkPath(cwd, 'cwd');
tl.cd(cwd);

echo.exec()
.then(function(code) {
    tl.exit(code);
})
.fail(function(err) {
    console.error(err.message);
    tl.debug('taskRunner fail');
    tl.exit(1);
})
