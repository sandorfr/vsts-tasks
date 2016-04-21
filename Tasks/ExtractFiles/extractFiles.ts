/// <reference path="../../definitions/vsts-task-lib.d.ts" />

import fs = require('fs');
import os = require('os');
import path = require('path');
import tl = require('vsts-task-lib/task');

var pattern: string = tl.getInput('pattern', true).trim();

var destinationFolder :string  = tl.getPathInput('destinationFolder', true, false).trim();

var cleanDestinationFolder: boolean = tl.getBoolInput('cleanDestinationFolder', false);

var repoRoot : string = path.resolve(tl.getVariable('build.sourcesDirectory') || '');
tl.debug('repoRoot: ' + repoRoot);

var win = os.type().match(/^Win/);
tl.debug('win: ' + win);

// extractors
var tarLocation : string;
var _sevenZipLocation : string; // lazily loaded, use accessor method

function getSevenZipLocation() {
    if (_sevenZipLocation == undefined) {

        if (win) {
            // http://www.7-zip.org/
            _sevenZipLocation = '7zip/7z.exe';
        } else {
            // https://sourceforge.net/projects/p7zip/
            _sevenZipLocation = 'p7zip/7z';

        }
    }
    return _sevenZipLocation;
}

function findFiles(fullSearchString: string): string[] {
    var patterns: string[] = splitPattern(fullSearchString);
    tl.debug('using: ' + patterns.length + ' patterns: '+patterns +' to search for archives.');

    // minimatch options
    var matchOptions = { matchBase: true };
    if (win) {
        matchOptions["nocase"] = true;
    }

    // use a set to avoid duplicates
    var Set = require('collections/set');
    var matchingFilesSet = new Set();

    for (var i = 0; i < patterns.length; i++) {
        tl.debug('searching for archives, pattern['+i+']: ' + patterns[i]);

        var normalizedPattern : string = path.normalize(patterns[i]);
        tl.debug('normalizedPattern= ' + normalizedPattern);

        var parseResult = parsePattern(normalizedPattern);

        if (parseResult.file != null) {
            try {
                var stats = fs.statSync(parseResult.file);
                if (stats.isFile()) {
                    if (matchingFilesSet.add(parseResult.file)) {
                        tl.debug('adding file: ' + parseResult.file);
                    }
                    matchingFilesSet.add(parseResult.file);
                } else if (stats.isDirectory()) { // most likely error scenario is user specified a directory
                    failTask('Specified archive: ' + parseResult.file + ' can not be extracted because it is a directory.');
                } else { // other error scenarios -- less likely
                    failTask('Specified archive: ' + parseResult.file + ' can not be extracted because it is not a file.');
                }
            } catch (e) { // typically because it does not exist
                failTask('Specified archive: ' + parseResult.file + ' can not be extracted because it can not be accessed: ' + e);
            }
        } else {
            console.log('Searching for: ' + parseResult.search + ' under directory: ' + parseResult.directory);

            if (!fs.existsSync(parseResult.directory)) {
                failTask('Search failed because the specified search directory: ' + parseResult.directory + ' does not exist.');
            } else if (!fs.lstatSync(parseResult.directory).isDirectory()) {
                failTask('Search failed because the specified search directory: ' + file + ' is not a directory.');
            }

            var allFiles = tl.find(parseResult.directory);
            tl.debug('Candidates found for match: ' + allFiles.length);

            var matched = tl.match(allFiles, parseResult.search, matchOptions);

            // ensure only files are added, since our search results may include directories
            for (var j = 0; j < matched.length; j++) {
                var match = path.normalize(matched[j]);
                if (fs.lstatSync(match).isFile()) {
                    if (matchingFilesSet.add(match)){
                        tl.debug('adding file: ' + match);
                    }
                }
            }
        }
    }

    return matchingFilesSet.toArray();
}

function parsePattern(normalizedPattern: string): { file: string, directory: string, search: string }  {
    tl.debug('parsePattern: ' + normalizedPattern);

    // the first occurance of a wild card, * or ?
    var firstWildIndex = normalizedPattern.indexOf('*');
    var questionIndex = normalizedPattern.indexOf('?');
    if (questionIndex > -1 && (firstWildIndex == -1 || questionIndex < firstWildIndex)) {
        firstWildIndex = questionIndex;
    }

    // no wildcards
    if (firstWildIndex == -1) {
        return {
            file: makeAbsolute(normalizedPattern),
            directory: null,
            search: null
        };
    }

    // search backwards from the first wild card char for the nearest path separator
    for (var i = firstWildIndex - 1; i > -1; i--) {
        if (normalizedPattern.charAt(i) == path.sep) {
            return {
                file: null,
                directory: makeAbsolute(normalizedPattern.substring(0, i + 1)),
                search: normalizedPattern.substring(i + 1, normalizedPattern.length)
            };
        }
    }

    console.log('No path specified for search pattern: ' + normalizedPattern + ' defaulting to: ' + repoRoot);

    return {
        file: null,
        directory: repoRoot,
        search: normalizedPattern
    };
}

function makeAbsolute(normalizedPath: string): string {
    tl.debug('makeAbsolute:' + normalizedPath);

    var result = normalizedPath;
    if (!path.isAbsolute(normalizedPath)) {
        result = repoRoot + path.sep + normalizedPath;
        console.log('Relative file path: '+ normalizedPath+' resolving to: ' + result);
    }
    return result;
}

/**
 * Splits on comma, semicolon, or colon on linux
 * @param pattern
 */
function splitPattern(pattern: string) : string[] {
    var result : string [] = [];
    
    var commaSplit : string [] = pattern.split(','); // split on comman
    for (var i = 0; i < commaSplit.length; i++) {
        var semiColonSplit : string [] = commaSplit[i].split(';'); // split on semicolon
        for (var j = 0; j < semiColonSplit.length; j++) {
            if (win) {
                var subPattern: string = semiColonSplit[j].trim();
                if (subPattern.length > 0) {
                    result.push(subPattern);
                }
            } else { 
                var colonSplit: string[] = semiColonSplit[j].split(':'); //also split on colon on linux
                for (var k = 0; k < colonSplit.length; k++) {
                    var subPattern: string = colonSplit[k].trim(); 
                    if (subPattern.length > 0) {
                        result.push(subPattern);
                    }
                }
            }
        }
    }

    return result;
}


// Find matching archive files
var files: string [] = findFiles(pattern);
console.log('Found: ' + files.length + ' files to extract:');
for (var i = 0; i < files.length; i++) {
    console.log(files[i]);
}

// Clean the destination folder before extraction?
if (cleanDestinationFolder && tl.exist(destinationFolder)) {
    console.log('Cleaning destination folder before extraction: ' + destinationFolder);
    tl.rmRF(destinationFolder, false);
}
    
// Create the destination folder if it doesn't exist
if (!tl.exist(destinationFolder)) {
    console.log('Creating destination folder: ' + destinationFolder);
    tl.mkdirP(destinationFolder);
}

function isTar(file) {
    var name = win ? file.toLowerCase() : file;
    // standard gnu-tar extension formats with recognized auto compression formats
    // https://www.gnu.org/software/tar/manual/html_section/tar_69.html
    return name.endsWith('.tar')      // no compression
        || name.endsWith('.tar.gz')   // gzip
        || name.endsWith('.tgz')      // gzip
        || name.endsWith('.taz')      // gzip
        || name.endsWith('.tar.Z')    // compress
        || (win && name.endsWith('tar.z')) // no case comparison for win
        || name.endsWith('.taZ')      // compress // no case for win already handled above
        || name.endsWith('.tar.bz2')  // bzip2
        || name.endsWith('.tz2')      // bzip2
        || name.endsWith('.tbz2')     // bzip2
        || name.endsWith('.tbz')      // bzip2
        || name.endsWith('.tar.lz')   // lzip
        || name.endsWith('.tar.lzma') // lzma
        || name.endsWith('.tlz')      // lzma
        || name.endsWith('.tar.lzo')  // lzop
        || name.endsWith('.tar.xz')   // xz
        || name.endsWith('.txz');     // xz
}

function sevenZipExtract(file, destinationFolder) {
    console.log('Extracting file: ' + file);
    var sevenZip = tl.createToolRunner(getSevenZipLocation());
    console.log('7z path=' + sevenZip.toolPath);
    sevenZip.arg('x');
    sevenZip.arg('-o' + destinationFolder);
    sevenZip.arg(file);
    return handleExecResult(sevenZip.execSync(), file);
}

function tarExtract(file, destinationFolder) {
    console.log('Extracting file: ' + file);
    var tar = tl.createToolRunner(tarLocation);
    tar.arg('-xvf'); // tar will correctly handle compression types outlined in isTar()
    tar.arg(file);
    tar.arg('-C');
    tar.arg(destinationFolder);
    return handleExecResult(tar.execSync(), file);
}

function handleExecResult(execResult, file) {
    if (execResult.code != tl.TaskResult.Succeeded) {
        var message = 'Extraction failed for file: ' + file + ' See log for details.';
        failTask(message);
    }
}

function failTask(message: string) {
    tl.setResult(tl.TaskResult.Failed, message);
}

// Extract the archive files on a single thread for two reasons:
// 1 - Multiple threads munge the log messages
// 2 - Everything is going to be blocked by I/O anyway.
for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!fs.existsSync(file)) {
        failTask('Extraction failed for file: ' + file + ' because it does not exist.');
    }
    else if (fs.lstatSync(file).isDirectory()) {
        failTask('Extraction failed for file: ' + file + ' because it is a directory.');
    }
    else {
        if (isTar(file)) {
            if (typeof tarLocation == "undefined") {
                tarLocation = tl.which('tar', false);
            }
            if (tarLocation != null) { // use native tar if available
                tarExtract(file, destinationFolder);
            } else { // native tar unavailable, use bundled 7-zip
                var name = win ? file.toLowerCase() : file;
                if (name.endsWith('.tar')) { // a simple tar
                    sevenZipExtract(file, destinationFolder);
                } else { // a compressed tar, e.g. 'fullFilePath/test.tar.bz2'
                    // 7zip can not decompress and expand in one step, so it is necessary
                    // to do this in multiple steps as follows:
                    // 0. create a temporary location to decompress the tar to
                    // 1. decompress the tar to the temporary location
                    // 2. expand the decompressed tar to the output folder
                    // 3. remove the temporary location

                    // e.g. 'fullFilePath/test.tar.bz2' --> 'test.tar.bz2'
                    var shortFileName = file.substring(file.lastIndexOf(path.sep) +1, file.length);
                    // e.g. 'destinationFolder/_test.tar.bz2_'
                    var tempFolder = path.normalize(destinationFolder + path.sep + '_' + shortFileName + '_');
                    if (!tl.exist(tempFolder)) {
                        console.log('Creating temp folder: ' + tempFolder + ' to decompress: ' + file);
                        // 0 create temp folder
                        tl.mkdirP(tempFolder);
                        // 1 extract compressed tar
                        sevenZipExtract(file, tempFolder);
                        var tempTar = tempFolder + path.sep + fs.readdirSync(tempFolder)[0]; // should be only one
                        console.log('Decompressed temporary tar from: ' + file + ' to: ' + tempTar);
                        // 2 expand extracted tar
                        sevenZipExtract(tempTar, destinationFolder);
                        // 3 cleanup temp folder
                        console.log('Removing temp folder: ' + tempFolder);
                        tl.rmRF(tempFolder, false);
                    } else {
                        failTask('Extraction failed for file: ' + file + ' because temporary location could not be created: ' + tempFolder);
                    }
                }
            }
        } else { // not a tar
            sevenZipExtract(file, destinationFolder);
        }
    }
}

tl.setResult(tl.TaskResult.Succeeded, 'Successfully extracted all files.');
