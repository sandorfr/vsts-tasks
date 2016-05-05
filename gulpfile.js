// node built-ins
var cp = require('child_process');
var exec = require('child_process').exec;
var fs = require('fs');
var path = require('path');
var os = require('os');

// build/test script
var minimist = require('minimist');
var mocha = require('gulp-mocha');
var Q = require('q');
var semver = require('semver');
var shell = require('shelljs');

// gulp modules
var del = require('del');
var gts = require('gulp-typescript');
var gulp = require('gulp');
var gutil = require('gulp-util');
var pkgm = require('./package');
var typescript = require('typescript');
var zip = require('gulp-zip');

// validation
var NPM_MIN_VER = '3.0.0';
var MIN_NODE_VER = '4.0.0';

if (semver.lt(process.versions.node, MIN_NODE_VER)) {
    console.error('requires node >= ' + MIN_NODE_VER + '.  installed: ' + process.versions.node);
    process.exit(1);
}

/*----------------------------------------------------------------------------------------
Distinct build, test and Packaging Phases:

Build:
- validate the task.json for each task
- generate task.loc.json file and strings file for each task.  allows for hand off to loc.
- compile .ts --> .js
- "link" in the vsts-task-lib declared in package.json into tasks using node handler

Test:
- Run Tests (L0, L1) - see docs/runningtests.md
- copy the mock task-lib to the root of the temp test folder
- Each test:
   - copy task to a temp dir.
   - delete linked copy of task-lib (so it uses the mock one above)
   - run

Package (only on windows):
- zip the tasks.
- if nuget found (windows):
  - create nuget package
  - if server url, publish package - this is for our VSO build 
----------------------------------------------------------------------------------------*/

//
// Options
//
var mopts = {
    string: 'suite',
    default: { suite: '**' }
};

var options = minimist(process.argv.slice(2), mopts);

//
// Paths
//
var _buildRoot = path.join(__dirname, '_build', 'Tasks');
var _testRoot = path.join(__dirname, '_build', 'Tests');
var _testTemp = path.join(_testRoot, 'Temp');
var _pkgRoot = path.join(__dirname, '_package');
var _oldPkg = path.join(__dirname, 'Package');
var _wkRoot = path.join(__dirname, '_working');
var _tempPath = path.join(__dirname, '_temp');

//-----------------------------------------------------------------------------------------------------------------
// Build Tasks
//-----------------------------------------------------------------------------------------------------------------

function errorHandler(err) {
    process.exit(1);
}

var proj = gts.createProject('./tsconfig.json', { typescript: typescript });
var ts = gts(proj);

gulp.task('clean', function (cb) {
    del([_buildRoot, _pkgRoot, _wkRoot, _oldPkg], cb);
});

// compile tasks inline
gulp.task('compileTasks', ['clean'], function (cb) {
    try {
        getNpmExternal('vsts-task-lib');
        getNpmExternal('vsts-task-sdk');
    }
    catch (err) {
        console.log('error:' + err.message);
        cb(new gutil.PluginError('compileTasks', err.message));
        return;
    }


    var tasksPath = path.join(__dirname, 'Tasks', '**/*.ts');
    return gulp.src([tasksPath, 'definitions/*.d.ts'], { base: './Tasks' })
        .pipe(ts)
        .on('error', errorHandler)
        .pipe(gulp.dest(path.join(__dirname, 'Tasks')));
});

gulp.task('compile', ['compileTasks', 'compileTests']);

gulp.task('locCommon', ['compileTasks'], function () {
    return gulp.src(path.join(__dirname, 'Tasks/Common/**/module.json'))
        .pipe(pkgm.LocCommon());
});

gulp.task('build', ['locCommon'], function () {
    // Load the dependency references to the intra-repo modules.
    var commonDeps = require('./common.json');
    var commonSrc = path.join(__dirname, 'Tasks/Common');

    // Layout the tasks.
    shell.mkdir('-p', _buildRoot);
    return gulp.src(path.join(__dirname, 'Tasks', '**/task.json'))
        .pipe(pkgm.PackageTask(_buildRoot, commonDeps, commonSrc));
});

gulp.task('default', ['build']);

//-----------------------------------------------------------------------------------------------------------------
// Test Tasks
//-----------------------------------------------------------------------------------------------------------------

gulp.task('cleanTests', function (cb) {
    del([_testRoot], cb);
});

gulp.task('compileTests', ['cleanTests'], function (cb) {
    var testsPath = path.join(__dirname, 'Tests', '**/*.ts');

    return gulp.src([testsPath, 'definitions/*.d.ts'], { base: './Tests' })
        .pipe(ts)
        .on('error', errorHandler)
        .pipe(gulp.dest(_testRoot));
});

gulp.task('testLib', ['compileTests'], function (cb) {
    return gulp.src(['Tests/lib/**/*'])
        .pipe(gulp.dest(path.join(_testRoot, 'lib')));
});

gulp.task('copyTestData', ['compileTests'], function (cb) {
    return gulp.src(['Tests/**/data/**'], { dot: true })
        .pipe(gulp.dest(_testRoot));
});

gulp.task('ps1tests', ['compileTests'], function (cb) {
    return gulp.src(['Tests/**/*.ps1', 'Tests/**/*.json'])
        .pipe(gulp.dest(_testRoot));
});

gulp.task('testLib_NodeModules', ['testLib'], function (cb) {
    return gulp.src(path.join(_testRoot, 'lib/vsts-task-lib/**/*'))
        .pipe(gulp.dest(path.join(_testRoot, 'lib/node_modules/vsts-task-lib')));
});

gulp.task('testResources', ['testLib_NodeModules', 'ps1tests', 'copyTestData']);

gulp.task('test', ['testResources'], function () {
    process.env['TASK_TEST_TEMP'] = _testTemp;
    shell.rm('-rf', _testTemp);
    shell.mkdir('-p', _testTemp);

    var suitePath = path.join(_testRoot, options.suite + '/_suite.js');
    var tfBuild = ('' + process.env['TF_BUILD']).toLowerCase() == 'true'
    return gulp.src([suitePath])
        .pipe(mocha({ reporter: 'spec', ui: 'bdd', useColors: !tfBuild }));
});

//-----------------------------------------------------------------------------------------------------------------
// INTERNAL BELOW
//
// This particular task is for internal microsoft publishing as a nuget package for the VSO build to pick-up
// Contributors should not need to run this task
// This task requires windows and direct access to the internal nuget drop
//-----------------------------------------------------------------------------------------------------------------

gulp.task('bumpjs', function () {
    var tasksRootFolder = path.resolve(__dirname, 'Tasks');

    var taskFolders = [];
    fs.readdirSync(tasksRootFolder).forEach(folderName => {
        if (folderName != 'Common' && fs.statSync(path.join(tasksRootFolder, folderName)).isDirectory()) {
            taskFolders.push(path.join(tasksRootFolder, folderName));
        }
    })

    for (var i = 0; i < taskFolders.length; i++) {
        var taskFolder = taskFolders[i];

        var taskjson = path.join(taskFolder, 'task.json');
        var task = require(taskjson);

        if (task.execution['Node']) {
            task.version.Patch = task.version.Patch + 1;
            fs.writeFileSync(taskjson, JSON.stringify(task, null, 4));
        }
    }
});

gulp.task('bumpps', function () {
    var tasksRootFolder = path.resolve(__dirname, 'Tasks');

    var taskFolders = [];
    fs.readdirSync(tasksRootFolder).forEach(folderName => {
        if (folderName != 'Common' && fs.statSync(path.join(tasksRootFolder, folderName)).isDirectory()) {
            taskFolders.push(path.join(tasksRootFolder, folderName));
        }
    })

    for (var i = 0; i < taskFolders.length; i++) {
        var taskFolder = taskFolders[i];

        var taskjson = path.join(taskFolder, 'task.json');
        var task = require(taskjson);

        if (task.execution['PowerShell3']) {
            task.version.Patch = task.version.Patch + 1;
            fs.writeFileSync(taskjson, JSON.stringify(task, null, 4));
        }
    }
});

var getNpmExternal = function (name) {
    var externals = require('./externals.json');
    var libVer = externals[name];
    if (!libVer) {
        throw new Error('External module not defined in externals.json: ' + name);
    }

    gutil.log('acquiring ' + name + ': ' + libVer);

    var libPath = path.join(_tempPath, name, libVer);
    shell.mkdir('-p', path.join(libPath, 'node_modules'));

    var pkg = {
        "name": "temp",
        "version": "1.0.0",
        "description": "temp to avoid warnings",
        "main": "index.js",
        "dependencies": {},
        "devDependencies": {},
        "repository": "http://norepo/but/nowarning",
        "scripts": {
            "test": "echo \"Error: no test specified\" && exit 1"
        },
        "author": "",
        "license": "MIT"
    };
    fs.writeFileSync(path.join(_tempPath, 'package.json'), JSON.stringify(pkg, null, 2));

    shell.pushd(libPath);
    var completedPath = path.join(libPath, 'installcompleted');
    if (shell.test('-f', completedPath)) {
        console.log('Package already installed. Skipping.');
        shell.popd();
        return;
    }

    var npmPath = shell.which('npm');
    if (!npmPath) {
        throw new Error('npm not found.  ensure npm 3 or greater is installed');
    }

    var s = cp.execSync('"' + npmPath + '" --version');
    var ver = s.toString().replace(/[\n\r]+/g, '')
    console.log('version: "' + ver + '"');

    if (semver.lt(ver, NPM_MIN_VER)) {
        throw new Error('NPM version must be at least ' + NPM_MIN_VER + '. Found ' + ver);
    }

    var cmdline = '"' + npmPath + '" install ' + name + '@' + libVer;
    var res = cp.execSync(cmdline);
    gutil.log(res.toString());

    shell.popd();
    if (res.status > 0) {
        throw new Error('npm failed with code of ' + res.status);
    }

    fs.writeFileSync(completedPath, '');
}

var QExec = function (commandLine) {
    var defer = Q.defer();

    gutil.log('running: ' + commandLine)
    var child = exec(commandLine, function (err, stdout, stderr) {
        if (err) {
            defer.reject(err);
            return;
        }

        if (stdout) {
            gutil.log(stdout);
        }

        if (stderr) {
            gutil.log(stderr);
        }

        defer.resolve();
    });

    return defer.promise;
}

gulp.task('zip', ['build'], function (done) {
    shell.mkdir('-p', _wkRoot);
    var zipPath = path.join(_wkRoot, 'contents');

    return gulp.src(path.join(_buildRoot, '**', '*'))
        .pipe(zip('Microsoft.TeamFoundation.Build.Tasks.zip'))
        .pipe(gulp.dest(zipPath));
});

//
// gulp package --version 1.0.31 [--server <nugetServerLocation>]
//
gulp.task('package', ['zip'], function (done) {
    var nugetPath = shell.which('nuget');
    if (!nugetPath) {
        done(new gutil.PluginError('PackageTask', 'nuget.exe needs to be in the path.  could not find.'));
        return;
    }

    var nuget3Path = shell.which('nuget3');
    if (!nuget3Path) {
        done(new gutil.PluginError('PackageTask', 'nuget3.exe needs to be in the path.  could not find.'));
        return;
    }

    var options = minimist(process.argv.slice(2), {});
    var version = options.version;
    if (!version) {
        done(new gutil.PluginError('PackageTask', 'supply version with --version'));
        return;
    }

    if (!semver.valid(version)) {
        done(new gutil.PluginError('PackageTask', 'invalid semver version: ' + version));
        return;
    }

    var server = options.server;

    shell.mkdir('-p', _pkgRoot);

    var pkgName = 'Mseng.MS.TF.Build.Tasks';

    gutil.log('Generating .nuspec file');
    var contents = '<?xml version="1.0" encoding="utf-8"?>' + os.EOL;
    contents += '<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">' + os.EOL;
    contents += '   <metadata>' + os.EOL;
    contents += '      <id>' + pkgName + '</id>' + os.EOL;
    contents += '      <version>' + version + '</version>' + os.EOL;
    contents += '      <authors>bigbldt</authors>' + os.EOL;
    contents += '      <owners>bigbldt,Microsoft</owners>' + os.EOL;
    contents += '      <requireLicenseAcceptance>false</requireLicenseAcceptance>' + os.EOL;
    contents += '      <description>For VSS internal use only</description>' + os.EOL;
    contents += '      <tags>VSSInternal</tags>' + os.EOL;
    contents += '   </metadata>' + os.EOL;
    contents += '</package>' + os.EOL;

    var nuspecPath = path.join(_wkRoot, pkgName + '.nuspec');
    fs.writeFile(nuspecPath, contents, function (err) {
        if (err) {
            done(new gutil.PluginError('PackageTask', err.message));
            return;
        }

        var cmdline = '"' + nugetPath + '" pack ' + nuspecPath + ' -OutputDirectory ' + _pkgRoot;
        QExec(cmdline)
            .then(function () {
                // publish only if version and source supplied - used by CI server that does official publish
                if (server) {

                    var nuget3Path = shell.which('nuget3');
                    if (!nuget3Path) {
                        done(new gutil.PluginError('PackageTask', 'nuget3.exe needs to be in the path.  could not find.'));
                        return;
                    }

                    var pkgLocation = path.join(_pkgRoot, pkgName + '.' + version + '.nupkg');
                    var cmdline = '"' + nuget3Path + '" push ' + pkgLocation + ' -Source ' + server + ' -apikey Skyrise';
                    return QExec(cmdline);
                }
                else {
                    return;
                }

            })
            .then(function () {
                done();
            })
            .fail(function (err) {
                done(new gutil.PluginError('PackageTask', err.message));
            })

    });
});
