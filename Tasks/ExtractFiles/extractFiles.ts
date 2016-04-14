/// <reference path="../../definitions/vsts-task-lib.d.ts" />

import fs = require('fs');
import os = require('os');

import tl = require('vsts-task-lib/task');

function findFiles(sourceFolder, filePattern) {
    'use strict';

    var matchingFiles = [filePattern];

    if (filePattern.indexOf('*') >= 0 || filePattern.indexOf('?') >= 0) {
        tl.debug('Searching ' + sourceFolder + ' for archive files using: ' + filePattern);
        
        // minimatch options
        var matchOptions = { matchBase: true };
        if (os.type().match(/^Win/)) {
            matchOptions["nocase"] = true;
        }

        var allFiles = tl.find(sourceFolder);
        tl.debug('Candidates found for match: ' + allFiles.length);

        matchingFiles = tl.match(allFiles, filePattern, matchOptions);
    }

    if (!matchingFiles) {
        tl.warning('No matching files found.');
        return null;
    }

    return matchingFiles;
}

var win = os.type().match(/^Win/);
var sourceFolder = tl.getPathInput('SourceFolder', true, true);
var filePattern = tl.getInput('FilePattern', true);
var targetFolder = tl.getPathInput('TargetFolder', true, false);
var cleanTargetFolder = tl.getBoolInput('CleanTargetFolder', false);
var failOnExtractionError = tl.getBoolInput('FailOnExtractionError', true);

// Find matching archive files
var files = findFiles(sourceFolder, filePattern);

// Clean the target folder before extraction?
if (cleanTargetFolder && tl.exist(targetFolder)) {
    console.log('Cleaning target folder before extraction: ' + targetFolder);
    tl.rmRF(targetFolder, false);
}
    
// Create the target folder if it doesn't exist
if (!tl.exist(targetFolder)) {
    console.log('Creating target folder: ' + targetFolder);
    tl.mkdirP(targetFolder);
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
function isZip(file) {
    var name = win ? file.toLowerCase() : file;
    return name.endsWith('.zip')
        || name.endsWith('.jar')
        || name.endsWith('.war')
        || name.endsWith('.ear');
}

function sevenZipExtract(file, targetFolder) {
    console.log('Extracting file: ' + file);
    var sevenZip = tl.createToolRunner(sevenZipLocation);
    sevenZip.arg('x');
    sevenZip.arg('-o' + targetFolder);
    sevenZip.arg(file);
    return handleExecResult(sevenZip.execSync(), file);
}

function tarExtract(file, targetFolder) {
    console.log('Extracting file: ' + file);
    var tar = tl.createToolRunner(tarLocation);
    tar.arg('-xvf'); // tar will correctly handle compression types outlined in isTar()
    tar.arg(file);
    tar.arg('-C');
    tar.arg(targetFolder);
    return handleExecResult(tar.execSync(), file);
}

function handleExecResult(execResult, file) {
    if (execResult.code == tl.TaskResult.Failed) {
        extractionFailed = true;
        var message = 'Extraction failed for file: ' + file + ' with error message: ' + execResult.error;
        failedToExtract(message);
    }
    return execResult;
}

// set to true if any of the specified files can not be extracted for any reason
var extractionFailed = false;

function failedToExtract(message) {
    console.log(message);
    extractionFailed = true;
    if (failOnExtractionError) {
        tl.setResult(tl.TaskResult.Failed, message);
    }
}

// extractors
var tarLocation;
var sevenZipLocation = tl.which('7z', false); // TODO load from bundled location
// Extract the archive files

for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!fs.existsSync(file)) {
        failedToExtract('Extraction failed for file: ' + file + ' because it does not exist.');
    }
    else if (fs.lstatSync(file).isDirectory()) {
        failedToExtract('Extraction failed for file: ' + file + ' because it is a directory.');
    }
    else {
        if (isTar(file)) {
            if (typeof tarLocation == "undefined") {
                tarLocation = tl.which('tar', false);
            }
            if (tarLocation != null) { // use native tar if available
                tarExtract(file, targetFolder);
            } else { // native tar unavailable, use bundled 7-zip
                var name = win ? file.toLowerCase() : file;
                if (name.endsWith('.tar')) { // a simple tar
                    sevenZipExtract(file, targetFolder);
                } else { // a compressed tar
                    // 0. create a temporary location to decompress the tar to
                    // 1. decompress the tar to a temporary location
                    // 2. expand the tar to the output folder
                    // 3. remove the temporary location

                    // 0
                    var shortFileName = file.substring(file.lastIndexOf('/') + 1, file.length);
                    console.log('shortFileName=' + shortFileName);
                    var shortTarName = shortFileName.substring(0, shortFileName.lastIndexOf('.'));
                    if (!shortTarName.endsWith('.tar')) {
                        shortTarName += '.tar';
                    }
                    console.log('shortTarName=' + shortTarName);
                    var tempFolder = targetFolder + '/_' + shortFileName + '_';
                    if (!tl.exist(tempFolder)) {
                        console.log('Extracting file: ' + file);
                        console.log('Creating temp folder: ' + tempFolder + ' to decompress: ' + shortFileName);
                        // 0
                        tl.mkdirP(tempFolder);
                        // 1
                        var outerSevenZipExecResult = sevenZipExtract(file, tempFolder);
                        if (outerSevenZipExecResult.code == tl.TaskResult.Succeeded) {
                            var tempTar = tempFolder + '/' + fs.readdirSync(tempFolder)[0]; // should be only one
                            console.log('Decompressed temporary tar from: ' + file + ' to: ' + tempTar);
                            // 2
                            sevenZipExtract(tempTar, targetFolder);
                        }
                        // 3
                        console.log('Removing temp folder: ' + tempFolder);
                        tl.rmRF(tempFolder, false);
                    }
                    else {
                        console.log('Skipping: ' + file + ' because temporary location could not be created: ' + tempFolder);
                    }
                }
            }
        } else { // not a tar
            sevenZipExtract(file, targetFolder);
        }
    }
}

if (extractionFailed) {
    var message = 'Extraction failed for some files.  See console log for details.'
    console.log(message);
    tl.setResult(tl.TaskResult.Failed, message);
} else {
    var message = 'Successfully all files.';
    console.log(message)
    tl.setResult(tl.TaskResult.Succeeded, message);
}