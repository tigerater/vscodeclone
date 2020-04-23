/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

let path = require('path');
let cp = require('child_process');
let fs = require('fs');
let File = require('vinyl');
let es = require('event-stream');
let filter = require('gulp-filter');

let watcherPath = path.join(__dirname, 'watcher.exe');

function toChangeType(type) {
	switch (type) {
		case '0': return 'change';
		case '1': return 'add';
		default: return 'unlink';
	}
}

function watch(root) {
	let result = es.through();
	let child = cp.spawn(watcherPath, [root]);

	child.stdout.on('data', function (data) {
		let lines = data.toString('utf8').split('\n');
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i].trim();
			if (line.length === 0) {
				continue;
			}

			let changeType = line[0];
			let changePath = line.substr(2);

			// filter as early as possible
			if (/^\.git/.test(changePath) || /(^|\\)out($|\\)/.test(changePath)) {
				continue;
			}

			let changePathFull = path.join(root, changePath);

			let file = new File({
				path: changePathFull,
				base: root
			});
			file.event = toChangeType(changeType);
			result.emit('data', file);
		}
	});

	child.stderr.on('data', function (data) {
		result.emit('error', data);
	});

	child.on('exit', function (code) {
		result.emit('error', 'Watcher died with code ' + code);
		child = null;
	});

	process.once('SIGTERM', function () { process.exit(0); });
	process.once('SIGTERM', function () { process.exit(0); });
	process.once('exit', function () { child && child.kill(); });

	return result;
}

let cache = Object.create(null);

module.exports = function (pattern, options) {
	options = options || {};

	let cwd = path.normalize(options.cwd || process.cwd());
	let watcher = cache[cwd];

	if (!watcher) {
		watcher = cache[cwd] = watch(cwd);
	}

	let rebase = !options.base ? es.through() : es.mapSync(function (f) {
		f.base = options.base;
		return f;
	});

	return watcher
		.pipe(filter(['**', '!.git{,/**}'])) // ignore all things git
		.pipe(filter(pattern))
		.pipe(es.map(function (file, cb) {
			fs.stat(file.path, function (err, stat) {
				if (err && err.code === 'ENOENT') { return cb(null, file); }
				if (err) { return cb(); }
				if (!stat.isFile()) { return cb(); }

				fs.readFile(file.path, function (err, contents) {
					if (err && err.code === 'ENOENT') { return cb(null, file); }
					if (err) { return cb(); }

					file.contents = contents;
					file.stat = stat;
					cb(null, file);
				});
			});
		}))
		.pipe(rebase);
};
