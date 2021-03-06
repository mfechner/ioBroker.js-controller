/**
 *      Object DB in memory - Server
 *
 *      Copyright 2013-2018 bluefox <dogafox@gmail.com>
 *
 *      MIT License
 *
 */

/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
/* jshint -W061 */
'use strict';

const extend      = require('node.extend');
const fs          = require('fs');
const path        = require('path');
const socketio    = require('socket.io');
const tools       = require(__dirname + '/../tools');
const getDefaultDataDir = tools.getDefaultDataDir;

const stream      = require('stream');
const util        = require('util');
const Writable    = stream.Writable;
let   memStore    = {};

const ACCESS_EVERY_EXEC  = 0x1;
const ACCESS_EVERY_WRITE = 0x2;
const ACCESS_EVERY_READ  = 0x4;
const ACCESS_EVERY_RW    = ACCESS_EVERY_WRITE | ACCESS_EVERY_READ;
const ACCESS_EVERY_ALL   = ACCESS_EVERY_WRITE | ACCESS_EVERY_READ | ACCESS_EVERY_EXEC;

const ACCESS_GROUP_EXEC  = 0x10;
const ACCESS_GROUP_WRITE = 0x20;
const ACCESS_GROUP_READ  = 0x40;
const ACCESS_GROUP_RW    = ACCESS_GROUP_WRITE | ACCESS_GROUP_READ;
const ACCESS_GROUP_ALL   = ACCESS_GROUP_WRITE | ACCESS_GROUP_READ | ACCESS_GROUP_EXEC;

const ACCESS_USER_EXEC   = 0x100;
const ACCESS_USER_WRITE  = 0x200;
const ACCESS_USER_READ   = 0x400;
const ACCESS_USER_RW     = ACCESS_USER_WRITE | ACCESS_USER_READ;
const ACCESS_USER_ALL    = ACCESS_USER_WRITE | ACCESS_USER_READ | ACCESS_USER_EXEC;

const ACCESS_WRITE       = 0x2;
const ACCESS_READ        = 0x4;
const ACCESS_LIST        = 'list';
const ACCESS_DELETE      = 'delete';
const ACCESS_CREATE      = 'create';

const SYSTEM_ADMIN_USER  = 'system.user.admin';
const SYSTEM_ADMIN_GROUP = 'system.group.administrator';

/* Writable memory stream */
function WMStrm(key, options) {
    // allow use without new operator
    if (!(this instanceof WMStrm)) return new WMStrm(key, options);

    Writable.call(this, options); // init super
    this.key = key; // save key
    memStore[key] = new Buffer(''); // empty
}
util.inherits(WMStrm, Writable);

WMStrm.prototype._write = function (chunk, enc, cb) {
	if (chunk) {
 		// our memory store stores things in buffers
		let buffer = (Buffer.isBuffer(chunk)) ?
			chunk :  // already is Buffer use it
			new Buffer(chunk, enc);  // string, convert

		// concatenate to the buffer already there
        if (!memStore[this.key]) {
            memStore[this.key] = new Buffer('');
            console.log('memstore for ' + this.key + ' is null');
        }
		memStore[this.key] = Buffer.concat([memStore[this.key], buffer]);
	}
    if (!cb) throw 'Callback is empty';
	cb();
};

function ObjectsInMemServer(settings) {
    if (!(this instanceof ObjectsInMemServer)) return new ObjectsInMemServer(settings);
    settings = settings || {};

    let change;
    let zlib;
    let that             = this;
    let objects          = {};
    let fileOptions      = {};
    let files            = {};
    let configTimer      = null;
    let writeTimer       = null;
    let writeIds         = [];
    let users            = {};
    let groups           = {};
    let preserveSettings = [];
    let regUser          = /^system\.user/;
    let regGroup         = /^system\.group/;
    let regCheckId       = /[\]\[*,;'"`<>\\?]/;
    let defaultAcl       = {
        groups: [],
        acl: {
            file: {
                list:     false,
                read:     false,
                write:    false,
                create:   false,
                'delete': false
            },
            object: {
                list:     false,
                read:     false,
                write:    false,
                'delete': false
            }
        }
    };
    let defaultNewAcl    = settings.defaultNewAcl || null;
    let namespace        = settings.namespace || settings.hostname || '';
    let lastSave         = null;

    let dataDir = (settings.connection.dataDir || getDefaultDataDir());
    if (dataDir) {
        if (dataDir[0] === '.' && dataDir[1] === '.') {
            dataDir = __dirname + '/../../' + dataDir;
        } else if (dataDir[0] === '.' && dataDir[1] === '/') {
            dataDir = __dirname + '/../../' + dataDir.substring(2);
        }
    }
    dataDir = path.normalize(dataDir);
    dataDir = dataDir.replace(/\\/g, '/');
    if (dataDir[dataDir.length - 1] !== '/') dataDir += '/';

    // Create data directory
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir);
    }

    let objectsName  = dataDir + 'objects.json';
    const objectsDir = dataDir + 'files/';

    settings.backup = settings.backup || {
        disabled:   false,  // deactivates
        files:      24,     // minimum number of files
        hours:      48,     // hours
        period:     120,    // minutes
        path:       ''      // absolute path
    };
    const backupDir  = settings.backup.path || (dataDir + 'backup-objects/');

    if (!settings.backup.disabled) {
        zlib = zlib || require('zlib');
        // Interval in minutes => to milliseconds
        settings.backup.period = settings.backup.period === undefined ? 120 : parseInt(settings.backup.period);
        if (isNaN(settings.backup.period)) {
            settings.backup.period = 120;
        }
        settings.backup.period *= 60000;

        settings.backup.files = settings.backup.files === undefined ? 24 : parseInt(settings.backup.files);
        if (isNaN(settings.backup.files)) {
            settings.backup.files = 24;
        }

        settings.backup.hours = settings.backup.hours === undefined ? 48 : parseInt(settings.backup.hours);
        if (isNaN(settings.backup.hours)) {
            settings.backup.hours = 48;
        }
        // Create backup directory
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir);
        }
    }

    let log = settings.logger;
    if (!log) {
        log = {
            silly: function (msg) {/*console.log(msg);*/},
            debug: function (msg) {/*console.log(msg);*/},
            info:  function (msg) {/*console.log(msg);*/},
            warn:  function (msg) {
                console.log(msg);
            },
            error: function (msg) {
                console.log(msg);
            }
        };
    } else if (!log.silly) {
        log.silly = log.debug;
    }

    let server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };

    /*function prepareRights(options) {
     let fOptions = {};
     options = options || {};
     if (!options.user) {
     options = {
     user: SYSTEM_ADMIN_USER,
     params: options
     };
     }

     // acl.owner = user that creates or owns the file
     // acl.group = group, that assigned to file
     // acl.permissions = '0777' - default 1 (execute, 2 write, 4 read
     if (!options.user) {
     fOptions.acl = {
     owner:      SYSTEM_ADMIN_USER,
     ownerGroup: SYSTEM_ADMIN_GROUP,
     permissions: 0x644 // '0777'
     };
     } else {
     fOptions.acl = {
     owner: options.user
     };
     fOptions.acl.ownerGroup  = options.group;
     fOptions.acl.permissions = 0x644;
     }
     fOptions.acl.ownerGroup  = fOptions.acl.ownerGroup || SYSTEM_ADMIN_GROUP;

     return fOptions;
     }*/

    // -------------- FILE FUNCTIONS -------------------------------------------
    // memServer specific function
    function mkpathSync(rootpath, dirpath) {
        // Remove filename
        dirpath = dirpath.split('/');
        dirpath.pop();
        if (!dirpath.length) return;

        for (let i = 0; i < dirpath.length; i++) {
            rootpath += dirpath[i] + '/';
            if (!fs.existsSync(rootpath)) {
                fs.mkdirSync(rootpath);
            }
        }
    }

    function saveFileSettings(id, force) {
        if (typeof id === 'boolean') {
            force = id;
            id = undefined;
        }

        if (id !== undefined && writeIds.indexOf(id) === -1) writeIds.push(id);

        if (writeTimer) clearTimeout(writeTimer);

        // if store immediately
        if (force) {
            writeTimer = null;
            // Store dirs description
            for (let _id = 0; _id < writeIds.length; _id++) {
                try {
                    fs.writeFileSync(objectsDir + writeIds[_id] + '/_data.json', JSON.stringify(fileOptions[writeIds[_id]]));
                } catch (e) {
                    log.error(namespace + ' Cannot write files: ' + objectsDir + writeIds[_id] + '/_data.json: ' + e.message);
                }
            }
            writeIds = [];
        } else {
            writeTimer = setTimeout(function () {
                // Store dirs description
                for (let id = 0; id < writeIds.length; id++) {
                    try {
                        fs.writeFileSync(objectsDir + writeIds[id] + '/_data.json', JSON.stringify(fileOptions[writeIds[id]]));
                    } catch (e) {
                        log.error(namespace + ' Cannot write files: ' + objectsDir + writeIds[id] + '/_data.json: ' + e.message);
                    }
                }
                writeIds = [];
            }, 1000);
        }
    }

    function checkFile(id, name, options, flag) {
        if (typeof fileOptions[id][name].acl !== 'object') {
            fileOptions[id][name] = {
                mimeType: fileOptions[id][name],
                acl: {
                    owner:       (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER,
                    ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP,
                    permissions: (defaultNewAcl && defaultNewAcl.file)       || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ) // '0644'
                }
            };
        }

        // Set default owner group
        fileOptions[id][name].acl.ownerGroup  = fileOptions[id][name].acl.ownerGroup  || (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP;
        fileOptions[id][name].acl.owner       = fileOptions[id][name].acl.owner       || (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER;
        fileOptions[id][name].acl.permissions = fileOptions[id][name].acl.permissions || (defaultNewAcl && defaultNewAcl.file)       || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ); // '0644'

        if (options.user !== SYSTEM_ADMIN_USER &&
            options.groups.indexOf(SYSTEM_ADMIN_GROUP) === -1 &&
            fileOptions[id][name].acl) {
            if (fileOptions[id][name].acl.owner !== options.user) {
                // Check if the user is in the group
                if (options.groups.indexOf(fileOptions[id][name].acl.ownerGroup) !== -1) {
                    // Check group rights
                    if (!(fileOptions[id][name].acl.permissions & (flag << 4))) {
                        return false;
                    }
                } else {
                    // everybody
                    if (!(fileOptions[id][name].acl.permissions & flag)) {
                        return false;
                    }
                }
            } else {
                // Check user rights
                if (!(fileOptions[id][name].acl.permissions & (flag << 8))) {
                    return false;
                }
            }
        }
        return true;
    }

    function checkFileRights(id, name, options, flag, callback) {
        options = options || {};
        if (!options.user) {
            // Before files converted, lets think: if no options it is admin
            options = {
                user:    SYSTEM_ADMIN_USER,
                params:  options,
                group:   SYSTEM_ADMIN_GROUP
            };
        }

        if (!options.acl) {
            return that.getUserGroup(options.user, function (user, groups, acl) {
                options.acl    = acl || {};
                options.groups = groups;
                options.group  = groups ? groups[0] : null;
                checkFileRights(id, name, options, flag, callback);
            });
        }
        // If user may write
        if (flag === ACCESS_WRITE && !options.acl.file.write) {// write
            return callback('permissionError', options);
        }
        // If user may read
        if (flag === ACCESS_READ && !options.acl.file.read) {// read
            return callback('permissionError', options);
        }

        // read rights of file
        if (!fileOptions[id]) {
            if (fs.existsSync(objectsDir + id + '/_data.json')) {
                try {
                    fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'utf8'));
                } catch (e) {
                    log.error(namespace + ' Cannot parse ' + objectsDir + id + '/_data.json: ' + e);
                }
            } else {
                fileOptions[id] = {};
            }
        }

        if (!name || !fileOptions[id] || !fileOptions[id][name]) {
            return callback(null, options);
        }
        if (checkFile(id, name, options,flag)) {
            return callback(null, options);
        } else {
            return callback('permissionError', options);
        }

        /*if (typeof fileOptions[id][name].acl !== 'object') {
         fileOptions[id][name] = {
         mimeType: fileOptions[id][name],
         acl: {
         owner:       SYSTEM_ADMIN_USER,
         permissions: 0x644,
         ownerGroup:  SYSTEM_ADMIN_GROUP
         }
         };
         }
         // Set default onwer group
         fileOptions[id][name].acl.ownerGroup = fileOptions[id][name].acl.ownerGroup || SYSTEM_ADMIN_GROUP;

         if (options.user !== SYSTEM_ADMIN_USER &&
         options.groups.indexOf(SYSTEM_ADMIN_GROUP) === -1 &&
         fileOptions[id][name].acl) {
         if (fileOptions[id][name].acl.owner !== options.user) {
         // Check if the user is in the group
         if (options.groups.indexOf(fileOptions[id][name].acl.ownerGroup) !== -1) {
         // Check group rights
         if (!(fileOptions[id][name].acl.permissions & (flag << 4))) {
         return callback('permissionError', options);
         }
         } else {
         // everybody
         if (!(fileOptions[id][name].acl.permissions & flag)) {
         return callback('permissionError', options);
         }
         }
         } else {
         // Check user rights
         if (!(fileOptions[id][name].acl.permissions & (flag << 8))) {
         return callback('permissionError', options);
         }
         }
         }
         return callback(null, options);*/
    }

    function setDefaultAcl(callback) {
        try {
            defaultNewAcl = Object.assign({}, objects['system.config'].common.defaultNewAcl);
        } catch (e) {
            defaultNewAcl = {
                owner:      SYSTEM_ADMIN_USER,
                ownerGroup: SYSTEM_ADMIN_GROUP,
                object:     (ACCESS_USER_RW | ACCESS_GROUP_RW | ACCESS_EVERY_READ),
                state:      (ACCESS_USER_RW | ACCESS_GROUP_RW | ACCESS_EVERY_READ),
                file:       (ACCESS_USER_RW | ACCESS_GROUP_RW | ACCESS_EVERY_READ)
            };
            objects['system.config'].common.defaultNewAcl = Object.assign({}, defaultNewAcl);
        }

        let count = 0;
        // Set all objects without ACL to this one
        for (let id in objects) {
            if (objects.hasOwnProperty(id) && objects[id] && !objects[id].acl) {
                objects[id].acl = Object.assign({}, defaultNewAcl);
                delete objects[id].acl.file;
                if (objects[id].type !== 'state') {
                    delete objects[id].acl.state;
                }

                count++;
            }
        }
        if (typeof callback === 'function') callback(null, count);
    }

    this.getUserGroup = function (user, callback) {
        if (!user || typeof user !== 'string' || !user.match(/^system\.user\./)) {
            console.log('invalid user name: ' + user);
            user = JSON.stringify(user);
            return callback.call(this, user, [], Object.assign({}, defaultAcl.acl));
        }
        if (users[user]) {
            return callback.call(this, user, users[user].groups, users[user].acl);
        }

        // Read all groups
        this.getObjectList({startkey: 'system.group.', endkey: 'system.group.\u9999'}, {checked: true}, (err, arr) => {
            if (err) log.error(namespace + ' ' + err);
            groups = [];
            if (arr) {
                // Read all groups
                for (let g = 0; g < arr.rows.length; g++) {
                    groups[g] = arr.rows[g].value;
                    if (groups[g]._id === SYSTEM_ADMIN_GROUP) {
                        groups[g].common.acl = {
                            file: {
                                list:     true,
                                read:     true,
                                write:    true,
                                create:   true,
                                'delete': true
                            },
                            object: {
                                list:     true,
                                read:     true,
                                write:    true,
                                create:   true,
                                'delete': true
                            },
                            users: {
                                list:     true,
                                read:     true,
                                write:    true,
                                create:   true,
                                'delete': true
                            }
                        };
                    }
                }
            }

            this.getObjectList({startkey: 'system.user.', endkey: 'system.user.\u9999'}, {checked: true}, (err, arr) => {
                if (err) log.error(namespace + ' ' + err);
                users = {};

                if (arr) {
                    for (let i = 0; i < arr.rows.length; i++) {
                        users[arr.rows[i].value._id] = Object.assign({}, defaultAcl);
                        if (arr.rows[i].value._id === SYSTEM_ADMIN_USER) {
                            users[SYSTEM_ADMIN_USER].acl.file = {
                                list:     true,
                                read:     true,
                                write:    true,
                                create:   true,
                                'delete': true
                            };
                            users[SYSTEM_ADMIN_USER].acl.object = {
                                create:   true,
                                list:     true,
                                read:     true,
                                write:    true,
                                'delete': true
                            };
                            users[SYSTEM_ADMIN_USER].acl.users = {
                                create:   true,
                                list:     true,
                                read:     true,
                                write:    true,
                                'delete': true
                            };
                        }
                    }
                }

                for (let g = 0; g < groups.length; g++) {
                    if (!groups[g].common.members) continue;
                    for (let m = 0; m < groups[g].common.members.length; m++) {
                        let u = groups[g].common.members[m];
                        if (!users[u]) {
                            log.warn('Unknown user in group "' + g + '": ' + u);
                            continue;
                        }
                        users[u].groups.push(groups[g]._id);

                        if (groups[g].common.acl && groups[g].common.acl.file) {
                            if (!users[u].acl || !users[u].acl.file) {
                                users[u].acl      = users[u].acl || {};
                                users[u].acl.file = users[u].acl.file || {};

                                users[u].acl.file.create    = groups[g].common.acl.file.create;
                                users[u].acl.file.read      = groups[g].common.acl.file.read;
                                users[u].acl.file.write     = groups[g].common.acl.file.write;
                                users[u].acl.file['delete'] = groups[g].common.acl.file['delete'];
                                users[u].acl.file.list      = groups[g].common.acl.file.list;
                            } else {
                                users[u].acl.file.create    = users[u].acl.file.create    || groups[g].common.acl.file.create;
                                users[u].acl.file.read      = users[u].acl.file.read      || groups[g].common.acl.file.read;
                                users[u].acl.file.write     = users[u].acl.file.write     || groups[g].common.acl.file.write;
                                users[u].acl.file['delete'] = users[u].acl.file['delete'] || groups[g].common.acl.file['delete'];
                                users[u].acl.file.list      = users[u].acl.file.list      || groups[g].common.acl.file.list;
                            }
                        }

                        if (groups[g].common.acl && groups[g].common.acl.object) {
                            if (!users[u].acl || !users[u].acl.object) {
                                users[u].acl        = users[u].acl || {};
                                users[u].acl.object = users[u].acl.object || {};

                                users[u].acl.object.create    = groups[g].common.acl.object.create;
                                users[u].acl.object.read      = groups[g].common.acl.object.read;
                                users[u].acl.object.write     = groups[g].common.acl.object.write;
                                users[u].acl.object['delete'] = groups[g].common.acl.object['delete'];
                                users[u].acl.object.list      = groups[g].common.acl.object.list;
                            } else {
                                users[u].acl.object.create    = users[u].acl.object.create    || groups[g].common.acl.object.create;
                                users[u].acl.object.read      = users[u].acl.object.read      || groups[g].common.acl.object.read;
                                users[u].acl.object.write     = users[u].acl.object.write     || groups[g].common.acl.object.write;
                                users[u].acl.object['delete'] = users[u].acl.object['delete'] || groups[g].common.acl.object['delete'];
                                users[u].acl.object.list      = users[u].acl.object.list      || groups[g].common.acl.object.list;
                            }
                        }

                        if (groups[g].common.acl && groups[g].common.acl.users) {
                            if (!users[u].acl || !users[u].acl.users) {
                                users[u].acl       = users[u].acl || {};
                                users[u].acl.users = users[u].acl.users || {};

                                users[u].acl.users.create    = groups[g].common.acl.users.create;
                                users[u].acl.users.read      = groups[g].common.acl.users.read;
                                users[u].acl.users.write     = groups[g].common.acl.users.write;
                                users[u].acl.users['delete'] = groups[g].common.acl.users['delete'];
                                users[u].acl.users.list      = groups[g].common.acl.users.list;

                            } else {
                                users[u].acl.users.create    = users[u].acl.users.create    || groups[g].common.acl.users.create;
                                users[u].acl.users.read      = users[u].acl.users.read      || groups[g].common.acl.users.read;
                                users[u].acl.users.write     = users[u].acl.users.write     || groups[g].common.acl.users.write;
                                users[u].acl.users['delete'] = users[u].acl.users['delete'] || groups[g].common.acl.users['delete'];
                                users[u].acl.users.list      = users[u].acl.users.list      || groups[g].common.acl.users.list;
                            }
                        }
                    }
                }

                callback.call(this, user, users[user] ? users[user].groups : [], users[user] ? users[user].acl : Object.assign({}, defaultAcl.acl));
            });
        });
    };

    const mimeTypes = {
        '.css':     {type: 'text/css',                  binary: false},
        '.bmp':     {type: 'image/bmp',                 binary: true},
        '.png':     {type: 'image/png',                 binary: true},
        '.jpg':     {type: 'image/jpeg',                binary: true},
        '.jpeg':    {type: 'image/jpeg',                binary: true},
        '.gif':     {type: 'image/gif',                 binary: true},
        '.ico':     {type: 'image/x-icon',              binary: true},
        '.webp':    {type: 'image/webp',                binary: true},
        '.wbmp':    {type: 'image/vnd.wap.wbmp',        binary: true},
        '.tif':     {type: 'image/tiff',                binary: true},
        '.js':      {type: 'application/javascript',    binary: false},
        '.html':    {type: 'text/html',                 binary: false},
        '.htm':     {type: 'text/html',                 binary: false},
        '.json':    {type: 'application/json',          binary: false},
        '.md':      {type: 'text/markdown',             binary: false},
        '.xml':     {type: 'text/xml',                  binary: false},
        '.svg':     {type: 'image/svg+xml',              binary: false},
        '.eot':     {type: 'application/vnd.ms-fontobject', binary: true},
        '.ttf':     {type: 'application/font-sfnt',     binary: true},
        '.cur':     {type: 'application/x-win-bitmap',  binary: true},
        '.woff':    {type: 'application/font-woff',     binary: true},
        '.wav':     {type: 'audio/wav',                 binary: true},
        '.mp3':     {type: 'audio/mpeg3',               binary: true},
        '.avi':     {type: 'video/avi',                 binary: true},
        '.qt':      {type: 'video/quicktime',           binary: true},
        '.ppt':     {type: 'application/vnd.ms-powerpoint', binary: true},
        '.pptx':    {type: 'application/vnd.ms-powerpoint', binary: true},
        '.doc':     {type: 'application/msword',        binary: true},
        '.docx':    {type: 'application/msword',        binary: true},
        '.xls':     {type: 'application/vnd.ms-excel',  binary: true},
        '.xlsx':    {type: 'application/vnd.ms-excel',  binary: true},
        '.mp4':     {type: 'video/mp4',                 binary: true},
        '.mkv':     {type: 'video/mkv',                 binary: true},
        '.zip':     {type: 'application/zip',           binary: true},
        '.ogg':     {type: 'audio/ogg',                 binary: true},
        '.manifest':{type: 'text/cache-manifest',       binary: false},
        '.pdf':     {type: 'application/pdf',           binary: true},
        '.gz':      {type: 'application/gzip',          binary: true},
        '.gzip':    {type: 'application/gzip',          binary: true},
    };

    this.getMimeType = function (ext) {
        if (ext instanceof Array) ext = ext[0];
        let _mimeType = 'text/javascript';
        let isBinary  = false;

        if (mimeTypes[ext]) {
            _mimeType = mimeTypes[ext].type;
            isBinary = mimeTypes[ext].binary;
        } else {
            _mimeType = 'text/javascript';
        }

        return {mimeType: _mimeType, isBinary: isBinary};
    };

    this.insert = function (id, attName, ignore, options, obj, callback) {
        if (typeof options === 'string') {
            options = {mimeType: options};
        }

        //return pipe for write into redis
        let strm = new WMStrm(id + '/' + attName);
        strm.on('finish', () => {
            if (!memStore[id + '/' + attName]) log.error(namespace + ' File ' + id + ' / ' +  attName + ' is empty');
            this.writeFile(id, attName, memStore[id + '/' + attName] || '', options, function () {
                if (memStore[id + '/' + attName] !== undefined) delete memStore[id + '/' + attName];
                if (callback) setImmediate(callback, null, null);
            });
        });
        return strm;
    };

    function sanitizePath(id, name, callback) {
        if (name[0] === '/') name = name.substring(1);

        if (!id) {
            if (typeof callback === 'function') {
                callback('Empty ID');
            }
            return;
        }

        if (id) {
            id = id.replace(/\.\./g, ''); // do not allow to write in parent directories
        }

        if (name.indexOf('..') !== -1) {
            name = path.normalize(name);
            name = name.replace(/\//g, '/');
        }
        if (name[0] === '/') name = name.substring(1); // do not allow absolute paths

        return {id: id, name: name};
    }

    function _writeFile(id, name, data, options, callback) {
        try {
            try {
                if (!fs.existsSync(objectsDir))      fs.mkdirSync(objectsDir);
                if (!fs.existsSync(objectsDir + id)) fs.mkdirSync(objectsDir + id);
            } catch (e) {
                log.error(namespace + ' Cannot create directories: ' + objectsDir + id + ': ' + e.message);
                log.error(namespace + ' Check the permissions! Or call "sudo chmod -R 774 *" in ' + tools.appName +' dir');
                if (typeof callback === 'function') callback(e.message);
                return;
            }

            let isBinary;
            let ext         = name.match(/\.[^.]+$/);
            let mime        = that.getMimeType(ext);
            let _mimeType   = mime.mimeType;
            isBinary        = mime.isBinary;

            if (!fileOptions[id][name]) {
                fileOptions[id][name] = {createdAt: Date.now()};
            }
            if (!fileOptions[id][name].acl) {
                fileOptions[id][name].acl = {
                    owner:       options.user  || (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER,
                    ownerGroup:  options.group || (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP,
                    permissions: options.mode  || (defaultNewAcl && defaultNewAcl.file)       || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ)// 0x644
                };
            }

            fileOptions[id][name].mimeType       = options.mimeType || _mimeType;
            fileOptions[id][name].binary         = isBinary;
            fileOptions[id][name].acl.ownerGroup = fileOptions[id][name].acl.ownerGroup || (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP;
            fileOptions[id][name].modifiedAt     = Date.now();

            if (isBinary) {
                // Reload by read
                delete files[id][name];
            } else {
                files[id][name] = data;
            }

            try {
                // Create directories if complex structure
                mkpathSync(objectsDir + id + '/', name);
                // Store file
                fs.writeFileSync(objectsDir + id + '/' + name, data, {'flag': 'w', 'encoding': isBinary ? 'binary' : 'utf8'});
                // Store dir description
                saveFileSettings(id);
            } catch (e) {
                log.error(namespace + ' Cannot write files: ' + objectsDir + id + '/' + name + ': ' + e.message);
                if (typeof callback === 'function') callback(e.message);
                return;
            }
            if (typeof callback === 'function') callback();
        } catch (e) {
            if (typeof callback === 'function') callback(e.message);
        }
    }

    this.writeFile = function (id, name, data, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (typeof options === 'string') {
            options = {mimeType: options};
        }
        if (options && options.acl) {
            options.acl = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.writeFile(id, name, options, (err, res, mimeType) =>{
                    if (!err) {
                        resolve();
                    } else {
                        reject(err);
                    }
                });
            });
        }

        let _path = sanitizePath(id, name, callback);
        id = _path.id;
        name = _path.name;

        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    try {
                        fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'utf8'));
                    } catch (e) {
                        log.error(namespace + ' Cannot parse ' + objectsDir + id + '/_data.json: ' + e);
                    }
                } else {
                    fileOptions[id] = {};
                }
            }

            files[id] = files[id] || {};

            // If file yet exists => check the permissions
            return checkFileRights(id, name, options, ACCESS_WRITE, (err, options) => {
                if (err) {
                    if (typeof callback === 'function') {
                        callback(err);
                    }
                } else {
                    return _writeFile(id, name, data, options, callback);
                }
            });
        } catch (e) {
            if (typeof callback === 'function') callback(e.message);
        }
    };

    function _readFile(id, name, options, callback) {
        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    try {
                        fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'binary'));
                    } catch (e) {
                        log.error(namespace + ' Cannot parse ' + objectsDir + id + '/_data.json: ' + e);
                        fileOptions[id] = {};
                    }
                } else {
                    fileOptions[id] = {};
                }
            }

            if (!files[id]) files[id] = {};

            if (!files[id][name] || settings.connection.noFileCache || options.noFileCache) {
                if (fs.existsSync(objectsDir + id + '/' + name)) {
                    // Create description object if not exists
                    if (!fileOptions[id][name]) {
                        fileOptions[id][name] = {
                            acl: {
                                owner:       (defaultNewAcl && defaultNewAcl.owner)            || SYSTEM_ADMIN_USER,
                                ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup)       || SYSTEM_ADMIN_GROUP,
                                permissions: (defaultNewAcl && defaultNewAcl.file.permissions) || (ACCESS_USER_ALL | ACCESS_GROUP_ALL | ACCESS_EVERY_ALL) // 777

                            }
                        };
                    }
                    if (typeof fileOptions[id][name] !== 'object') {
                        fileOptions[id][name] = {
                            mimeType:    fileOptions[id][name],
                            acl: {
                                owner:       (defaultNewAcl && defaultNewAcl.owner)            || SYSTEM_ADMIN_USER,
                                ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup)       || SYSTEM_ADMIN_GROUP,
                                permissions: (defaultNewAcl && defaultNewAcl.file.permissions) || (ACCESS_USER_ALL | ACCESS_GROUP_ALL | ACCESS_EVERY_ALL) // 777
                            }
                        };
                    }

                    files[id][name] = fs.readFileSync(objectsDir + id + '/' + name);
                    if (fileOptions[id][name].binary === undefined) {
                        let pos = name.lastIndexOf('.');
                        let ext = '';
                        if (pos !== -1) ext = name.substring(pos);
                        let mimeType = that.getMimeType(ext);
                        fileOptions[id][name].binary   = mimeType.isBinary;
                        fileOptions[id][name].mimeType = mimeType.mimeType;
                    }

                    if (!fileOptions[id][name].binary) {
                        if (files[id][name]) files[id][name] = files[id][name].toString();
                    }
                } else {
                    if (fileOptions[id][name] !== undefined) delete fileOptions[id][name];
                    if (files[id][name]       !== undefined) delete files[id][name];
                }
            }

            if (fileOptions[id][name] && !fileOptions[id][name].acl) {
                // all files belongs to admin by default, but everyone can edit it
                fileOptions[id][name].acl = {
                    owner:       (defaultNewAcl && defaultNewAcl.owner)            || SYSTEM_ADMIN_USER,
                    ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup)       || SYSTEM_ADMIN_GROUP,
                    permissions: (defaultNewAcl && defaultNewAcl.file.permissions) || (ACCESS_USER_ALL | ACCESS_GROUP_ALL | ACCESS_EVERY_RW) // 776
                };
            }

            if (typeof callback === 'function') {
                if (fileOptions[id][name] !== null && fileOptions[id][name] !== undefined) {
                    if (!fileOptions[id][name].mimeType) {
                        let _pos = name.lastIndexOf('.');
                        let _ext = '';
                        if (_pos !== -1) _ext = name.substring(_pos);
                        let _mimeType = that.getMimeType(_ext);
                        fileOptions[id][name].mimeType = _mimeType.mimeType;
                    }
                    callback(null, files[id][name], fileOptions[id][name].mimeType);
                } else {
                    callback('Not exists');
                }
            }
        } catch (e) {
            log.warn(`Cannot read file ${id} / ${name}: ${JSON.stringify(e)}`);
            if (typeof callback === 'function') {
                callback(e.message);
            }
        }
    }

    this.readFile = function (id, name, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options  = null;
        }
        if (options && options.acl) {
            options.acl = null;
        }

        if (!callback) {
            return new Promise((resolve, reject) => {
                this.readFile(id, name, options, (err, res, mimeType) =>{
                    if (!err) {
                        resolve({data: res, mimeType: mimeType});
                    } else {
                        reject(err);
                    }
                });
            });
        }

        let _path = sanitizePath(id, name, callback);
        if (!_path) return;
        id = _path.id;
        name = _path.name;

        checkFileRights(id, name, options, ACCESS_READ, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                return _readFile(id, name, options, callback);
            }
        });
    };

    function _unlink(id, name, options, callback) {
        try {
            let changed = false;
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'utf8'));
                } else {
                    fileOptions[id] = {};
                }
            }
            if (fileOptions[id][name]) {
                changed = true;
                delete fileOptions[id][name];
            }
            if (files[id] && files[id][name]) {
                delete files[id][name];
            }
            if (fs.existsSync(objectsDir + id + '/' + name)) {
                let stat = fs.statSync(objectsDir + id + '/' + name);

                if (stat.isDirectory()) {
                    // read all entries and delete every one
                    let fdir = fs.readdirSync(objectsDir + id + '/' + name);
                    let cnt = 0;
                    for (let f = 0; f < fdir.length; f++) {
                        cnt++;
                        that.unlink(id, name + '/' + fdir[f], options, function (err) {
                            if (!--cnt) {
                                log.debug('Delete directory ' + id + '/' + name);
                                try {
                                    fs.rmdirSync(objectsDir + id + '/' + name);
                                } catch (e) {
                                    log.error('Cannot delete directory "' + id + '/' + name + '": ' + e);
                                }
                                if (typeof callback === 'function') {
                                    setImmediate(function () {
                                        callback(err);
                                    });
                                }
                            }
                        });
                    }
                    if (!cnt) {
                        log.debug('Delete directory ' + id + '/' + name);
                        try {
                            fs.rmdirSync(objectsDir + id + '/' + name);
                        } catch (e) {
                            log.error('Cannot delete directory "' + id + '/' + name + '": ' + e);
                        }
                        if (typeof callback === 'function') {
                            setImmediate(function () {
                                callback();
                            });
                        }
                    }
                } else {
                    log.debug('Delete file ' + id + '/' + name);
                    try {
                        fs.unlinkSync(objectsDir + id + '/' + name);
                    } catch (e) {
                        log.error('Cannot delete file "' + id + '/' + name + '": ' + e);
                    }
                    if (typeof callback === 'function') {
                        setImmediate(function () {
                            callback();
                        });
                    }
                }
            } else {
                if (typeof callback === 'function') {
                    setImmediate(function () {
                        callback('Not exists');
                    });
                }
            }
            // Store dir description
            if (changed) saveFileSettings(id);
        } catch (e) {
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback(e.message);
                });
            }
        }
    }

    this.unlink = function (id, name, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options  = null;
        }
        if (options && options.acl) {
            options.acl = null;
        }
        let _path = sanitizePath(id, name, callback);
        if (!_path) return;
        id   = _path.id;
        name = _path.name;

        checkFileRights(id, name, options, ACCESS_WRITE, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file['delete']) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _unlink(id, name, options, callback);
                }
            }
        });
    };

    this.delFile = this.unlink;

    function _readDir(id, name, options, callback) {
        if (!fileOptions[id]) {
            if (fs.existsSync(objectsDir + id + '/_data.json')) {
                try {
                    fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'binary'));
                } catch (e) {
                    log.error(namespace + ' Cannot parse ' + objectsDir + id + '/_data.json: ' + e);
                }
            } else {
                fileOptions[id] = {};
            }
        }
        // Find all files and directories starts with name
        let _files = [];

        if (name && name[name.length - 1] !== '/') name += '/';

        let len = (name) ? name.length : 0;
        for (let f in fileOptions[id]) {
            if (fileOptions[id].hasOwnProperty(f) && (!name || f.substring(0, len) === name)) {
                /** @type {string|string[]} */
                let rest = f.substring(len);
                rest = rest.split('/', 2);
                if (rest[0] && _files.indexOf(rest[0]) === -1) {
                    _files.push(rest[0]);
                }
            }
        }

        if (fs.existsSync(objectsDir + id + '/' + name)) {
            try {
                let dirFiles = fs.readdirSync(objectsDir + id + '/' + name);
                for (let i = 0; i < dirFiles.length; i++) {
                    if (dirFiles[i] === '..' || dirFiles[i] === '.') continue;
                    if (dirFiles[i] !== '_data.json' && _files.indexOf(dirFiles[i]) === -1) {
                        _files.push(dirFiles[i]);
                    }
                }
            } catch (e) {
                if (typeof callback === 'function') {
                    setImmediate(function () {
                        callback(e, []);
                    });
                }
                return;
            }
        } else {
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback('Not exists', []);
                });
            }
            return;
        }

        _files.sort();
        let res = [];
        for (let j = 0; j < _files.length; j++) {
            if (_files[j] === '..' || _files[j] === '.') continue;
            if (fs.existsSync(objectsDir + id + '/' + name + _files[j])) {
                let stats = fs.statSync(objectsDir + id + '/' + name + _files[j]);
                let acl = (fileOptions[id][name + _files[j]] && fileOptions[id][name + _files[j]].acl) ?
                    Object.assign({}, fileOptions[id][name + _files[j]].acl) : // copy settings
                    {
                        read:        true,
                        write :      true,
                        owner:       (defaultNewAcl && defaultNewAcl.owner)            || SYSTEM_ADMIN_USER,
                        ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup)       || SYSTEM_ADMIN_GROUP,
                        permissions: (defaultNewAcl && defaultNewAcl.file.permissions) || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ)
                    };

                try {
                    // if filter for user
                    if (options.filter && acl) {
                        // If user may not write
                        if (!options.acl.file.write) {// write
                            acl.permissions &= ~(ACCESS_USER_WRITE | ACCESS_GROUP_WRITE | ACCESS_EVERY_WRITE);
                        }
                        // If user may not read
                        if (!options.acl.file.read) {// read
                            acl.permissions &= ~(ACCESS_USER_READ | ACCESS_GROUP_READ | ACCESS_EVERY_READ);
                        }

                        if (options.user !== SYSTEM_ADMIN_USER && options.groups.indexOf(SYSTEM_ADMIN_GROUP) === -1) {
                            if (acl.owner !== options.user) {
                                // Check if the user is in the group
                                if (options.groups.indexOf(acl.ownerGroup) !== -1) {
                                    // Check group rights
                                    if (!(acl.permissions & ACCESS_GROUP_RW)) {
                                        continue;
                                    }
                                    acl.read  = !!(acl.permissions & ACCESS_GROUP_READ);
                                    acl.write = !!(acl.permissions & ACCESS_GROUP_WRITE);
                                } else {
                                    // everybody
                                    if (!(acl.permissions & ACCESS_EVERY_RW)) {
                                        continue;
                                    }
                                    acl.read  = !!(acl.permissions & ACCESS_EVERY_READ);
                                    acl.write = !!(acl.permissions & ACCESS_EVERY_WRITE);
                                }
                            } else {
                                // Check user rights
                                if (!(acl.permissions & ACCESS_USER_RW)) {
                                    continue;
                                }
                                acl.read  = !!(acl.permissions & ACCESS_USER_READ);
                                acl.write = !!(acl.permissions & ACCESS_USER_WRITE);
                            }
                        } else {
                            acl.read  = true;
                            acl.write = true;
                        }
                    }
                } catch (e) {
                    log.error(namespace + ' Cannot read permssions of  ' + objectsDir + id + '/' + name + _files[j] + ': ' + e);
                }

                res.push({
                    file:       _files[j],
                    stats:      stats,
                    isDir:      stats.isDirectory(),
                    acl:        acl,
                    modifiedAt: fileOptions[id][name + _files[j]] ? fileOptions[id][name + _files[j]].modifiedAt : undefined,
                    createdAt:  fileOptions[id][name + _files[j]] ? fileOptions[id][name + _files[j]].createdAt : undefined
                });
            }
        }

        if (typeof callback === 'function') {
            setImmediate(function () {
                callback(null, res);
            });
        }
    }

    this.readDir = function (id, name, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (options && options.acl) {
            options.acl = null;
        }
        let _path = sanitizePath(id, name, callback);
        if (!_path) return;
        id = _path.id;
        name = _path.name;

        checkFileRights(id, name, options, ACCESS_READ, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file.list) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _readDir(id, name, options, callback);
                }
            }
        });
    };

    function _rename(id, oldName, newName, options, callback) {
        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'utf8'));
                } else {
                    fileOptions[id] = {};
                }
            }
            if (fileOptions[id][oldName]) {
                let type = fileOptions[id][oldName];
                delete fileOptions[id][oldName];
                fileOptions[id][newName] = type;
                fs.writeFileSync(objectsDir + id + '/_data.json', JSON.stringify(fileOptions[id]));
            }
            if (files[id] && files[id][oldName]) {
                let data = files[id][oldName];
                delete files[id][oldName];
                files[id][newName] = data;
            }
            if (fs.existsSync(objectsDir + id + '/' + oldName)) {
                fs.renameSync(objectsDir + id + '/' + oldName, objectsDir + id + '/' + newName);
                if (typeof callback === 'function') callback();
            } else {
                if (typeof callback === 'function') callback('Not exists');
            }
        } catch (e) {
            if (typeof callback === 'function') callback(e.message);
        }
    }

    this.rename = function (id, oldName, newName, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (options && options.acl) {
            options.acl = null;
        }
        let _path = sanitizePath(id, oldName, callback);
        if (!_path) return;
        id = _path.id;
        oldName = _path.name;
        if (newName[0] === '/') newName = newName.substring(1);

        checkFileRights(id, oldName, options, ACCESS_WRITE, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file.write) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _rename(id, oldName, newName, options, callback);
                }
            }
        });
    };

    function _touch(id, name, options, callback) {
        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'utf8'));
                } else {
                    fileOptions[id] = {};
                }
            }

            let regEx = new RegExp(tools.pattern2RegEx(name));
            let processed = [];
            let now = Date.now();
            let changed = false;
            for (let f in fileOptions[id]) {
                if (!fileOptions[id].hasOwnProperty(f)) continue;
                if (regEx.test(f) && checkFile(id, f, options, ACCESS_WRITE)) {
                    changed = true;
                    // Check if file exists
                    if (fs.existsSync(objectsDir + id + '/' + f)) {
                        if (!fileOptions[id][f]) {
                            fileOptions[id][f] = {};
                            fileOptions[id][f].createdAt = now;
                        }

                        if (typeof fileOptions[id][f] !== 'object') {
                            fileOptions[id][f] = {
                                mimeType: fileOptions[id][f]
                            };
                        }

                        if (!fileOptions[id][f].mimeType) {
                            let pos = f.lastIndexOf('.');
                            let ext = '';
                            if (pos !== -1) ext = f.substring(pos);
                            let mimeType = that.getMimeType(ext);
                            fileOptions[id][f].binary   = mimeType.isBinary;
                            fileOptions[id][f].mimeType = mimeType.mimeType;
                        }

                        if (!fileOptions[id][f].acl) {
                            fileOptions[id][f].acl = {
                                owner:       (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER,
                                ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP,
                                permissions: (defaultNewAcl && defaultNewAcl.file)       || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ) // '0644'
                            };
                        }
                        let fOp = fileOptions[id][f];
                        fOp.modifiedAt = now;

                        let stats = fs.statSync(objectsDir + id + '/' + f);
                        let parts = f.split('/');
                        let fileName = parts.pop();
                        processed.push({
                            path:       parts.join('/'),
                            file:       fileName,
                            stats:      stats,
                            isDir:      stats.isDirectory(),
                            acl:        fOp.acl || {},
                            modifiedAt: fOp.modifiedAt,
                            createdAt:  fOp.createdAt
                        });
                    } else {
                        delete fileOptions[id][f];
                    }
                }
            }

            // Store dir description
            if (changed) fs.writeFileSync(objectsDir + id + '/_data.json', JSON.stringify(fileOptions[id]));

            if (typeof callback === 'function') callback(null, processed);
        } catch (e) {
            if (typeof callback === 'function') callback(e.message);
        }
    }

    this.touch = function (id, name, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (options && options.acl) {
            options.acl = null;
        }
        let _path = sanitizePath(id, name, callback);
        if (!_path) return;
        id = _path.id;
        name = _path.name;

        checkFileRights(id, null, options, ACCESS_WRITE, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                return _touch(id, name, options, callback);
            }
        });
    };

    function _rm(id, name, options, callback) {
        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'utf8'));
                } else {
                    fileOptions[id] = {};
                }
            }

            let regEx = new RegExp(tools.pattern2RegEx(name));
            let processed = [];
            let changed = false;
            let dirs = [];
            for (let f in fileOptions[id]) {
                if (!fileOptions[id].hasOwnProperty(f)) continue;
                if (regEx.test(f) && checkFile(id, f, options, ACCESS_WRITE)) {
                    let stat;
                    if (fileOptions[id][f]) {
                        changed = true;
                        delete fileOptions[id][f];
                    }
                    if (files && files[id] && files[id][f]) {
                        delete files[id][f];
                    }
                    if (fs.existsSync(objectsDir + id + '/' + f)) {
                        stat = fs.statSync(objectsDir + id + '/' + f);

                        if (stat.isDirectory()) {
                            if (dirs.indexOf(f) === -1) dirs.push(f);
                        } else {
                            fs.unlinkSync(objectsDir + id + '/' + f);
                        }
                    }
                    let parts = f.split('/');
                    let fileName = parts.pop();
                    let path = parts.join('/');
                    if (dirs.indexOf(path) === -1) dirs.push(path);
                    processed.push({
                        path:       path,
                        file:       fileName,
                        isDir:      stat && stat.isDirectory()
                    });
                }
            }

            // try to delete directories
            for (let d = 0; d < dirs.length; d++) {
                try {
                    let _files = fs.readdirSync(objectsDir + id + '/' + dirs[d]);

                    if (_files.length) {
                        console.log('Directory ' + id + '/' + dirs[d] + ' is not empty');
                    } else {
                        fs.rmdirSync(objectsDir + id + '/' + dirs[d]);
                    }
                } catch (e) {
                    console.error('Cannot delete ' + id + '/' + dirs[d] + ': ' + e);
                }
            }

            // Store dir description
            if (changed) fs.writeFileSync(objectsDir + id + '/_data.json', JSON.stringify(fileOptions[id]));

            if (typeof callback === 'function') callback(null, processed);
        } catch (e) {
            if (typeof callback === 'function') callback(e.message);
        }
    }

    this.rm = function (id, name, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (options && options.acl) {
            options.acl = null;
        }
        let _path = sanitizePath(id, name, callback);
        if (!_path) return;
        id = _path.id;
        name = _path.name;

        checkFileRights(id, null, options, ACCESS_WRITE, (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file['delete']) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _rm(id, name, options, callback);
                }
            }
        });
    };

    function _mkdir(id, dirname, options, callback) {
        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'utf8'));
                } else {
                    fileOptions[id] = {};
                }
            }
            if (!fs.existsSync(objectsDir + id + '/' + dirname)) {
                fs.mkdirSync(objectsDir + id + '/' + dirname);
                if (typeof callback === 'function') callback();
            } else {
                if (typeof callback === 'function') callback('Yet exists');
            }
        } catch (e) {
            if (typeof callback === 'function') callback(e.message);
        }
    }

    this.mkdir = function (id, dirname, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (options && options.acl) {
            options.acl = null;
        }
        let _path = sanitizePath(id, dirname, callback);
        if (!_path) return;
        id = _path.id;
        dirname = _path.name;

        checkFileRights(id, dirname, options, ACCESS_WRITE, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file.write) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _mkdir(id, dirname, options, callback);
                }
            }
        });
    };

    function _chownFile(id, name, options, callback) {
        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    try {
                        fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'binary'));
                    } catch (e) {
                        log.error(namespace + ' Cannot parse ' + objectsDir + id + '/_data.json: ' + e);
                    }
                } else {
                    fileOptions[id] = {};
                }
            }

            let regEx = new RegExp(tools.pattern2RegEx(name));
            let processed = [];
            let changed = false;
            for (let f in fileOptions[id]) {
                if (!fileOptions[id].hasOwnProperty(f)) continue;
                if (regEx.test(f) && checkFile(id, f, options, ACCESS_WRITE)) {
                    changed = true;
                    if (typeof fileOptions[id][f] !== 'object') {
                        fileOptions[id][f] = {
                            mimeType: fileOptions[id][f]
                        };
                    }

                    if (!fileOptions[id][f].acl) {
                        fileOptions[id][f].acl = {
                            owner:       (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER,
                            ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP,
                            permissions: (defaultNewAcl && defaultNewAcl.file)       || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ) // '0644'
                        };
                    }

                    fileOptions[id][f].acl.owner      = options.owner;
                    fileOptions[id][f].acl.ownerGroup = options.ownerGroup;

                    if (fs.existsSync(objectsDir + id + '/' + f)) {
                        let stats = fs.statSync(objectsDir + id + '/' + f);
                        let acl = fileOptions[id][f];
                        let parts = f.split('/');
                        let fileName = parts.pop();
                        processed.push({
                            path:       parts.join('/'),
                            file:       fileName,
                            stats:      stats,
                            isDir:      stats.isDirectory(),
                            acl:        acl.acl || {},
                            modifiedAt: fileOptions[id][f].modifiedAt,
                            createdAt:  fileOptions[id][f].createdAt
                        });
                    }
                }
            }

            // Store dir description
            if (changed) fs.writeFileSync(objectsDir + id + '/_data.json', JSON.stringify(fileOptions[id]));
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback(null, processed, id);
                });
            }
        } catch (e) {
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback(e.message);
                });
            }
        }
    }

    this.chownFile = function (id, name, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        options = options || {};
        if (typeof options !== 'object') {
            options = {owner: options};
        }
        options.acl = null;
        let _path = sanitizePath(id, name, callback);
        if (!_path) return;
        id = _path.id;
        name = _path.name;

        if (!options.ownerGroup && options.group) options.ownerGroup = options.group;
        if (!options.owner      && options.user)  options.owner      = options.user;

        if (!options.owner) {
            log.error(namespace + ' user is not defined');
            if (typeof callback === 'function') callback('invalid parameter');
            return;
        }

        if (!options.ownerGroup) {
            // get user group
            this.getUserGroup(options.owner, (user, groups /* , permissions */) => {
                if (!groups || !groups[0]) {
                    if (typeof callback === 'function') callback('user "' + options.owner + '" belongs to no group');
                    return;
                } else {
                    options.ownerGroup = groups[0];
                }
                this.chownFile(id, name, options, callback);
            });
            return;
        }

        checkFileRights(id, null, options, ACCESS_WRITE, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file.write) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _chownFile(id, name, options, callback);
                }
            }
        });
    };

    function _chmodFile(id, name, options, callback) {
        try {
            if (!fileOptions[id]) {
                if (fs.existsSync(objectsDir + id + '/_data.json')) {
                    try {
                        fileOptions[id] = JSON.parse(fs.readFileSync(objectsDir + id + '/_data.json', 'binary'));
                    } catch (e) {
                        log.error(namespace + ' Cannot parse ' + objectsDir + id + '/_data.json: ' + e);
                    }
                } else {
                    fileOptions[id] = {};
                }
            }

            let regEx = new RegExp(tools.pattern2RegEx(name));
            let processed = [];
            let changed = false;
            for (let f in fileOptions[id]) {
                if (!fileOptions[id].hasOwnProperty(f)) continue;
                if (regEx.test(f) && checkFile(id, f, options, ACCESS_WRITE)) {
                    changed = true;
                    if (typeof fileOptions[id][f] !== 'object') {
                        fileOptions[id][f] = {
                            mimeType: fileOptions[id][f]
                        };
                    }

                    if (!fileOptions[id][f].acl) {
                        fileOptions[id][f].acl = {
                            owner:       (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER,
                            ownerGroup:  (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP,
                            permissions: (defaultNewAcl && defaultNewAcl.file)       || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ) // '0644'
                        };
                    }

                    fileOptions[id][f].acl.permissions = options.mode;
                    if (fs.existsSync(objectsDir + id + '/' + f)) {
                        let stats = fs.statSync(objectsDir + id + '/' + f);
                        let acl = fileOptions[id][f];
                        let parts = f.split('/');
                        let fileName = parts.pop();
                        processed.push({
                            path:       parts.join('/'),
                            file:       fileName,
                            stats:      stats,
                            isDir:      stats.isDirectory(),
                            acl:        acl.acl || {},
                            modifiedAt: acl.modifiedAt,
                            createdAt:  acl.createdAt
                        });
                    }
                }
            }

            // Store dir description
            if (changed) fs.writeFileSync(objectsDir + id + '/_data.json', JSON.stringify(fileOptions[id]));
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback(null, processed, id);
                });
            }
        } catch (e) {
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback(e.message);
                });
            }
        }
    }

    this.chmodFile = function (id, name, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        options = options || {};
        options.acl = null;

        let _path = sanitizePath(id, name, callback);
        if (!_path) return;
        id = _path.id;
        name = _path.name;

        if (typeof options !== 'object') {
            options = {mode: options};
        }

        if (options.mode === undefined) {
            log.error(namespace + ' mode is not defined');
            if (typeof callback === 'function') callback('invalid parameter');
            return;
        } else if (typeof options.mode === 'string') {
            options.mode = parseInt(options.mode, 16);
        }

        checkFileRights(id, null, options, ACCESS_WRITE, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file.write) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _chmodFile(id, name, options, callback);
                }
            }
        });
    };

    function _enableFileCache(enabled, options, callback) {
        if (settings.connection.noFileCache !== enabled) {
            settings.connection.noFileCache = !!enabled;
            if (!settings.connection.noFileCache) {
                // clear cache
                files = {};
            }
        }
        if (typeof callback === 'function') {
            setImmediate(function () {
                callback(null, settings.connection.noFileCache);
            });
        }
    }

    this.enableFileCache = function (enabled, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }

        if (options && options.acl) {
            options.acl = null;
        }

        checkObjectRights(null, options, ACCESS_WRITE, (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                return _enableFileCache(enabled, options, callback);
            }
        });
    };

    // -------------- OBJECT FUNCTIONS -------------------------------------------
    function checkObject(id, options, flag) {
        // read rights of object
        if (!objects[id] || !objects[id].common || !objects[id].acl || flag === ACCESS_LIST) {
            return true;
        }

        // checkObject always called after checkObjectRights and admin is checked there
        if (objects[id].acl.owner !== options.user) {
            // Check if the user is in the group
            if (options.groups.indexOf(objects[id].acl.ownerGroup) !== -1) {
                // Check group rights
                if (!(objects[id].acl.object & (flag << 4))) {
                    return false;
                }
            } else {
                // everybody
                if (!(objects[id].acl.object & flag)) {
                    return false;
                }
            }
        } else {
            // Check group rights
            if (!(objects[id].acl.object & (flag << 8))) {
                return false;
            }
        }
        return true;
    }

    function checkObjectRights(id, options, flag, callback) {
        options = options || {};

        if (!options.user) {
            // Before files converted, lets think: if no options it is admin
            options = {
                user:    SYSTEM_ADMIN_USER,
                params:  options,
                group:   SYSTEM_ADMIN_GROUP,
                groups:  [SYSTEM_ADMIN_GROUP],
                acl: {
                    object: {
                        read:       true,
                        write:      true,
                        'delete':   true,
                        create:     true,
                        list:       true
                    },
                    file: {
                        read:       true,
                        write:      true,
                        'delete':   true,
                        create:     true,
                        list:       true
                    },
                    /*                    state: {
                     read: true,
                     write: true,
                     'delete': true,
                     create: true,
                     list: true
                     },*/
                    users:  {
                        read:       true,
                        write:      true,
                        create:     true,
                        'delete':   true,
                        list:       true
                    }
                }
            };
        }

        if (!options.acl) {
            return that.getUserGroup(options.user, (user, groups, acl) => {
                options.acl    = acl || {};
                options.groups = groups;
                options.group  = groups ? groups[0] : null;
                checkObjectRights(id, options, flag, callback);
            });
        }

        // now options are filled and we can go
        if (options.user === SYSTEM_ADMIN_USER || options.group === SYSTEM_ADMIN_GROUP || (options.groups && options.groups.indexOf(SYSTEM_ADMIN_GROUP) !== -1)) {
            return callback(null, options);
        }

        // if user or group objects
        if (regUser.test(id) || regGroup.test(id)) {
            // If user may write
            if (flag === ACCESS_WRITE && !options.acl.users.write) {// write
                return callback('permissionError', options);
            }

            // If user may read
            if (flag === ACCESS_READ && !options.acl.users.read) {// read
                return callback('permissionError', options);
            }

            // If user may delete
            if (flag === ACCESS_DELETE && !options.acl.users.delete) {// delete
                return callback('permissionError', options);
            }

            // If user may list
            if (flag === ACCESS_LIST && !options.acl.users.list) {// list
                return callback('permissionError', options);
            }

            // If user may create
            if (flag === ACCESS_CREATE && !options.acl.users.create) {// create
                return callback('permissionError', options);
            }

            if (flag === ACCESS_DELETE) flag = ACCESS_WRITE; // write
        }

        // If user may write
        if (flag === ACCESS_WRITE && !options.acl.object.write) {// write
            return callback('permissionError', options);
        }

        // If user may read
        if (flag === ACCESS_READ && !options.acl.object.read) {// read
            return callback('permissionError', options);
        }

        // If user may delete
        if (flag === ACCESS_DELETE && !options.acl.object.delete) {// delete
            return callback('permissionError', options);
        }

        // If user may list
        if (flag === ACCESS_LIST && !options.acl.object.list) {// list
            return callback('permissionError', options);
        }

        if (flag === ACCESS_DELETE) flag = ACCESS_WRITE; // write

        if (id && !checkObject(id, options, flag)) {
            return callback('permissionError', options);
        }

        return callback(null, options);
    }

    function clone(obj) {
        if (obj === null || obj === undefined || typeof obj !== 'object') {
            return obj;
        }

        let temp = obj.constructor(); // changed

        for (let key in obj) {
            if (obj.hasOwnProperty(key)) {
                temp[key] = clone(obj[key]);
            }
        }
        return temp;
    }

    function deleteOldBackupFiles() {
        // delete files only if settings.backupNumber is not 0
        let files = fs.readdirSync(backupDir);
        files.sort();
        const limit = Date.now() - settings.backup.hours * 3600000;

        for (let f = files.length - 1; f >= 0; f--) {
            if (!files[f].match(/_objects.json.gz$/)) {
                files.splice(f, 1);
            }
        }

        while (files.length > settings.backup.files) {
            let file = files.shift();
            // extract time
            const ms = new Date(file.substring(0, 10) + ' ' + file.substring(11, 16).replace('-', ':') + ':00').getTime();
            if (limit > ms) {
                try {
                    fs.unlinkSync(backupDir + file);
                } catch (e) {
                    log.error(`Cannot delete file "${backupDir + file}: ${JSON.stringify(e)}`);
                }
            }
        }
    }

    function getTimeStr(date) {
        let dateObj = new Date(date);

        let text = dateObj.getFullYear().toString() + '-';
        let v = dateObj.getMonth() + 1;
        if (v < 10) text += '0';
        text += v.toString() + '-';

        v = dateObj.getDate();
        if (v < 10) text += '0';
        text += v.toString() + '_';

        v = dateObj.getHours();
        if (v < 10) text += '0';
        text += v.toString() + '-';

        v = dateObj.getMinutes();
        if (v < 10) text += '0';
        text += v.toString();

        return text;
    }

    function saveConfig() {
        if (fs.existsSync(objectsName)) {
            let old = fs.readFileSync(objectsName);
            fs.writeFileSync(objectsName + '.bak', old);
        }
        try {
            const actual = JSON.stringify(objects);
            fs.writeFileSync(objectsName, actual);

            if (!settings.backup.disabled) {
                // save files for the last x hours
                const now = Date.now();

                // makes backups only if settings.backupInterval is not 0
                if (settings.backup.period && (!lastSave || now - lastSave > settings.backup.period)) {
                    lastSave = now;
                    let backFileName = backupDir + getTimeStr(now) + '_objects.json.gz';

                    if (!fs.existsSync(backFileName)) {
                        zlib = zlib || require('zlib');
                        let output = fs.createWriteStream(backFileName);
                        let compress = zlib.createGzip();
                        /* The following line will pipe everything written into compress to the file stream */
                        compress.pipe(output);
                        /* Since we're piped through the file stream, the following line will do:
                           'Hello World!'->gzip compression->file which is the desired effect */
                        compress.write(actual);
                        compress.end();

                        // analyse older files
                        deleteOldBackupFiles();
                    }
                }
            }
        } catch (e) {
            log.error(namespace + ' Cannot save file ' + objectsName + ': ' + e);
        }
        if (configTimer) {
            clearTimeout(configTimer);
            configTimer = null;
        }
    }

    function subscribe(socket, type, pattern, options) {
        socket._subscribe = socket._subscribe || {};
        let s = socket._subscribe[type] = socket._subscribe[type] || [];
        for (let i = 0; i < s.length; i++) {
            if (s[i].pattern === pattern) return;
        }

        s.push({pattern: pattern, regex: new RegExp(tools.pattern2RegEx(pattern)), options: options});
    }

    function unsubscribe(socket, type, pattern /*, options */) {
        if (!socket._subscribe || !socket._subscribe[type]) return;
        let s = socket._subscribe[type];
        for (let i = 0; i < s.length; i++) {
            if (s[i].pattern === pattern) {
                s.splice(i, 1);
                return;
            }
        }
    }

    function publish(socket, type, id, obj) {
        if (!socket._subscribe || !socket._subscribe[type]) return;
        let s = socket._subscribe[type];
        for (let i = 0; i < s.length; i++) {
            if (s[i].regex.test(id)) {
                socket.emit('message', s[i].pattern, id, obj);
                return;
            }
        }
    }

    function publishAll(type, id, obj) {
        if (id === undefined) {
            console.log('Problem');
        }

        let clients = server.io.sockets.connected;

        for (let i in clients) {
            if (clients.hasOwnProperty(i)) {
                publish(clients[i], type, id, obj);
            }
        }

        if (change && that._subscribe && that._subscribe[type]) {
            for (let j = 0; j < that._subscribe[type].length; j++) {
                if (that._subscribe[type][j].regex.test(id)) {
                    setImmediate(change, id, obj);
                    break;
                }
            }
        }
    }

    /*
    function storeHistory(id, obj) {
        let parts = id.split('.');
        let date = parts.pop();
        let file = historyName + date + '/' + parts.join('.') + '.json';

        if (!fs.existsSync(historyName + date)) fs.mkdirSync(historyName + date);

        fs.writeFileSync(file, JSON.stringify(obj.common.data, null, 2));

        delete obj.common.data;
    }

    function today() {
        let dateObj = new Date();

        let text = dateObj.getFullYear().toString();
        let v = dateObj.getMonth() + 1;
        if (v < 10) text += '0';
        text += v.toString();

        v = dateObj.getDate();
        if (v < 10) text += '0';
        text += v.toString();

        return text;
    }

    function loadHistory(id, obj) {
        let parts = id.split('.');
        let date = parts.pop();
        let file = historyName + date + '/' + parts.join('.') + '.json';

        if (fs.existsSync(file)) {
            if (!obj || !obj.common) {
                obj = {
                    type: 'history',
                    common: {
                        source: id,
                        day:    date,
                        data:   []
                    },
                    native: {}
                };
            }

            try {
                obj.common.data = JSON.parse(fs.readFileSync(file));
            } catch (e) {
                log.error(namespace + ' Cannot parse file ' + file + ': ' + e.message);
                obj.common.data = [];
            }
        }
    }*/

    function _subscribeConfig(pattern, options, callback) {
        subscribe(this, 'objects', pattern, options);
        if (typeof callback === 'function') {
            setImmediate(() => callback());
        }
    }

    this.subscribeConfig = function (pattern, options, callback) {
        let socket = this;
        checkObjectRights(null, options, 'list', (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                return _subscribeConfig.call(socket, pattern, options, callback);
            }
        });
    };
    this.subscribe   = this.subscribeConfig;

    function _unsubscribeConfig(pattern, options, callback) {
        unsubscribe(this, 'objects', pattern);
        // ignore options => unsubscribe may everyone
        if (typeof callback === 'function') {
            setImmediate(() => callback());
        }
    }
    this.unsubscribeConfig = function (pattern, options, callback) {
        let socket = this;
        checkObjectRights(null, options, 'list', (err, options) => {
            if (err) {
                if (typeof callback === 'function')callback(err);
            } else {
                return _unsubscribeConfig.call(socket, pattern, options, callback);
            }
        });
    };
    this.unsubscribe = this.unsubscribeConfig;

    function _chownObject(pattern, options, callback) {
        that.getConfigKeys(pattern, options, (err, keys) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
                return;
            }
            let list = [];
            for (let k = 0; k < keys.length; k++) {
                if (!checkObject(keys[k], options, ACCESS_WRITE)) continue;
                if (!objects[keys[k]].acl) {
                    objects[keys[k]].acl = {
                        owner:      (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER,
                        ownerGroup: (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP,
                        object:     (defaultNewAcl && defaultNewAcl.object)     || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ) // '0644'
                    };
                    if (objects[keys[k]].type === 'state') {
                        objects[keys[k]].acl.state = (defaultNewAcl && defaultNewAcl.state) || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ); // '0644'
                    }
                }
                objects[keys[k]].acl.owner      = options.owner;
                objects[keys[k]].acl.ownerGroup = options.ownerGroup;
                list.push(Object.assign({}, objects[keys[k]]));
            }
            if (typeof callback === 'function') callback(null, list);
            if (!configTimer) configTimer = setTimeout(saveConfig, 5000);
        });
    }
    this.chownObject = function (pattern, options, callback) {
        options = options || {};
        options.acl = null;

        if (typeof options !== 'object') {
            options = {owner: options};
        }

        if (!options.ownerGroup && options.group) options.ownerGroup = options.group;
        if (!options.owner && options.user)  options.owner = options.user;

        if (!options.owner) {
            log.error(namespace + ' user is not defined');
            if (typeof callback === 'function') callback('invalid parameter');
            return;
        }

        if (!options.ownerGroup) {
            // get user group
            this.getUserGroup(options.owner, (user, groups /* , permissions*/) => {
                if (!groups || !groups[0]) {
                    if (typeof callback === 'function') callback('user "' + options.owner + '" belongs to no group');
                    return;
                } else {
                    options.ownerGroup = groups[0];
                }
                this.chownObject(pattern, options, callback);
            });
            return;
        }

        checkObjectRights(null, options, ACCESS_WRITE, (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.object || !options.acl.object.write) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _chownObject(pattern, options, callback);
                }
            }
        });
    };

    function _chmodObject(pattern, options, callback) {
        that.getConfigKeys(pattern, options, (err, keys) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
                return;
            }
            let list = [];
            for (let k = 0; k < keys.length; k++) {
                if (!checkObject(keys[k], options, ACCESS_WRITE)) continue;
                if (!objects[keys[k]].acl) {
                    objects[keys[k]].acl = {
                        owner:      (defaultNewAcl && defaultNewAcl.owner)      || SYSTEM_ADMIN_USER,
                        ownerGroup: (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP,
                        object:     (defaultNewAcl && defaultNewAcl.object)     || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ) // '0644'
                    };
                    if (objects[keys[k]].type === 'state') {
                        objects[keys[k]].acl.state = (defaultNewAcl && defaultNewAcl.state) || (ACCESS_USER_RW | ACCESS_GROUP_READ | ACCESS_EVERY_READ); // '0644'
                    }
                }
                if (options.object !== undefined) objects[keys[k]].acl.object = options.object;
                if (options.state  !== undefined) objects[keys[k]].acl.state  = options.state;
                list.push(Object.assign({}, objects[keys[k]]));
            }
            if (typeof callback === 'function') callback(null, list);
            if (!configTimer) configTimer = setTimeout(saveConfig, 5000);
        });
    }
    this.chmodObject = function (pattern, options, callback) {
        options = options || {};
        options.acl = null;

        if (typeof options !== 'object') {
            options = {object: options};
        }

        if (options.mode && !options.object) options.object = options.mode;

        if (options.object === undefined) {
            log.error(namespace + ' mode is not defined');
            if (typeof callback === 'function') callback('invalid parameter');
            return;
        } else if (typeof options.mode === 'string') {
            options.mode = parseInt(options.mode, 16);
        }

        checkObjectRights(null, options, ACCESS_WRITE, (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file.write) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _chmodObject(pattern, options, callback);
                }
            }
        });
    };

    function _getObject(id, options, callback) {
        let obj = clone(objects[id]);
        // Read history from file
        /*if (regHistory.test(id)) {
            if (!obj) obj = {};
            if (!obj.common || !obj.common.data) loadHistory(id, obj);

            if (obj.common && (!objects[id] || !objects[id].common)) objects[id] = obj;

            // store the history for today in cache
            if (obj.common && obj.common.day) {
                if (today() === obj.common.day) {
                    objects[id].common.data = obj.common.data;
                } else if (objects[id].common.data) {
                    delete objects[id].common.data;
                }
            }
        }*/

        setImmediate(callback, null, obj);
    }
    this.getObject = function (id, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.getObject(id, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }

        if (typeof callback === 'function') {
            if (options && options.acl) {
                options.acl = null;
            }
            checkObjectRights(id, options, ACCESS_READ, (err, options) => {
                if (err) {
                    if (typeof callback === 'function') callback(err);
                } else {
                    return _getObject(id, options, callback);
                }
            });
        }
    };

    this.getObjectAsync = function (id, options) {
        return new Promise((resolve, reject) => {
            this.getObject(id, options, (err, obj) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(obj);
                }
            });
        });
    };

    function _getKeys(pattern, options, callback, dontModify) {
        let r = new RegExp(tools.pattern2RegEx(pattern));
        let result = [];
        for (let id in objects) {
            if (!objects.hasOwnProperty(id)) continue;
            if (r.test(id) && checkObject(id, options, ACCESS_LIST)) {
                result.push(id);
            }
        }
        result.sort();
        if (typeof callback === 'function') {
            setImmediate(function () {
                callback(null, result);
            });
        }
    }
    this.getKeys = function (pattern, options, callback, dontModify) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }

        if (!callback) {
            return new Promise((resolve, reject) => {
                this.getKeys(pattern, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                }, dontModify);
            });
        }

        if (options && options.acl) options.acl = null;
        checkObjectRights(null, options, 'list', (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                return _getKeys(pattern, options, callback, dontModify);
            }
        });
    };
    this.getConfigKeys = this.getKeys;

    function _getObjects(keys, options, callback, dontModify) {
        if (!keys) {
            if (typeof callback === 'function') callback('no keys', null);
            return;
        }
        if (!keys.length) {
            if (typeof callback === 'function') callback(null, []);
            return;
        }
        let result = [];
        for (let i = 0; i < keys.length; i++) {
            if (checkObject(keys[i], options, ACCESS_READ)) {
                result.push(clone(objects[keys[i]]));
            } else {
                result.push({error: 'permissionError'});
            }
        }
        if (typeof callback === 'function') {
            setImmediate(function () {
                callback(null, result);
            });
        }
    }

    this.getObjects = function (keys, options, callback, dontModify) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.getObjects(keys, options, (err, objs) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(objs);
                    }
                }, dontModify);
            });
        }

        if (options && options.acl) options.acl = null;
        if (typeof callback === 'function') {
            checkObjectRights(null, options, ACCESS_READ, (err, options) => {
                if (err) {
                    if (typeof callback === 'function') callback(err);
                } else {
                    return _getObjects(keys, options, callback, dontModify);
                }
            });
        }
    };

    function _getObjectsByPattern(pattern, options, callback) {
        let r = new RegExp(tools.pattern2RegEx(pattern));
        let keys = [];
        for (let id in objects) {
            if (!objects.hasOwnProperty(id)) continue;
            if (r.test(id) && checkObject(id, options, ACCESS_READ)) {
                keys.push(id);
            }
        }
        keys.sort();
        let result = [];
        for (let i = 0; i < keys.length; i++) {
            result.push(JSON.parse(JSON.stringify(objects[keys[i]])));
        }
        if (typeof callback === 'function') {
            setImmediate(function () {
                callback(null, result);
            });
        }
    }
    this.getObjectsByPattern = (pattern, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.getObjectsByPattern(pattern, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }
        if (options && options.acl) options.acl = null;
        if (typeof callback === 'function') {
            checkObjectRights(null, options, ACCESS_READ, (err, options) => {
                if (err) {
                    if (typeof callback === 'function') callback(err);
                } else {
                    return _getObjectsByPattern(pattern, options, callback);
                }
            });
        }
    };

    function _setObject(id, obj, options, callback) {
        if (!id || regCheckId.test(id)) {
            if (typeof callback === 'function') {
                callback(`Invalid ID: ${id}`);
            }
            return;
        }

        if (!obj) {
            log.error(namespace + ' setObject: Argument object is null');
            if (typeof callback === 'function') {
                callback('obj is null');
            }
            return;
        }

        obj._id = id;

        if (id === 'system.config' && obj && obj.common && objects[id] && objects[id].common && JSON.stringify(obj.common.defaultNewAcl) !== JSON.stringify(objects[id].common.defaultNewAcl)) {
            objects[id] = obj;
            return setDefaultAcl(() => that.setObject(id, obj, options, callback));
        }

        if (!tools.checkNonEditable(objects[id], obj)) {
            if (typeof callback === 'function') {
                callback('Invalid password for update of vendor information');
            }
            return;
        }

        // do not delete common settings, like "history" or "mobile". It can be erased only with "null"
        if (objects[id] && objects[id].common) {
            for (let i = 0; i < preserveSettings.length; i++) {
                // remove settings if desired
                if (obj.common && obj.common[preserveSettings[i]] === null) {
                    delete obj.common[preserveSettings[i]];
                    continue;
                }

                if (objects[id].common[preserveSettings[i]] !== undefined && (!obj.common || obj.common[preserveSettings[i]] === undefined)) {
                    if (!obj.common) obj.common = {};
                    obj.common[preserveSettings[i]] = objects[id].common[preserveSettings[i]];
                }
            }
        }

        if (objects[id] && objects[id].acl && !obj.acl) {
            obj.acl = objects[id].acl;
        }

        // add user default rights
        if (defaultNewAcl && !obj.acl) {
            obj.acl = Object.assign({}, defaultNewAcl);
            delete obj.acl.file;
            if (obj.type !== 'state') {
                delete obj.acl.state;
            }
            if (options.owner) {
                obj.acl.owner = options.owner;

                if (!options.ownerGroup) {
                    obj.acl.ownerGroup = null;
                    that.getUserGroup(options.owner, (user, groups /* , permissions */) => {
                        if (!groups || !groups[0]) {
                            options.ownerGroup = (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP;
                        } else {
                            options.ownerGroup = groups[0];
                        }
                        _setObject(id, obj, options, callback);
                    });
                    return;
                }
            }
        }
        if (defaultNewAcl && obj.acl && !obj.acl.ownerGroup && options.ownerGroup) {
            obj.acl.ownerGroup = options.ownerGroup;
        }

        objects[id] = JSON.parse(JSON.stringify(obj));
        publishAll('objects', id, obj);
        if (typeof callback === 'function') {
            setImmediate(function () {
                callback(null, {id: id});
            });
        }
        if (!configTimer) {
            configTimer = setTimeout(saveConfig, 5000);
        }
    }

    /**
     * set anew or update object
     *
     * This function writes the object into DB
     *
     * @alias setObject
     * @memberof objectsInMemServer
     * @param {string} id ID of the object
     * @param {object} obj
     * @param {object} options options for access control are optional
     * @param {function} callback return function
     */
    this.setObject = function (id, obj, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.setObject(id, obj, options, (err, res) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(res);
                    }
                });
            });
        }
        if (options && options.acl) options.acl = null;

        checkObjectRights(id, options, ACCESS_WRITE, (err, options) => {
            if (err) {
                if (typeof callback === 'function') {
                    callback(err);
                }
            } else {
                return _setObject(id, obj, options, callback);
            }
        });
    };

    this.setObjectAsync = (id, obj, options) => {
        return new Promise((resolve, reject) => {
            this.setObject(id, obj, options, (err, res) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(res);
                }
            })
        });
    };

    function _delObject(id, options, callback) {
        if (objects[id]) {
            if (objects[id].common && objects[id].common.dontDelete) {
                if (typeof callback === 'function') {
                    setImmediate(callback, 'Object is marked as non deletable');
                }
                return;
            }

            delete objects[id];
            publishAll('objects', id, null);
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback(null);
                });
            }
            if (!configTimer) {
                configTimer = setTimeout(saveConfig, 5000);
            }
        } else {
            if (typeof callback === 'function') {
                setImmediate(function () {
                    callback('Not exists');
                });
            }
        }
    }
    this.delObject = function (id, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.delObject(id, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }

        if (options && options.acl) options.acl = null;
        checkObjectRights(id, options, ACCESS_DELETE, (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                return _delObject(id, options, callback);
            }
        });
    };

    this.delObjectAsync = function (id, options) {
        return new Promise((resolve, reject) => {
            this.delObject(id, options, err => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    };

    function _applyView(func, params, options, callback) {
        let result = {
            rows: []
        };

        function _emit_(id, obj) {
            result.rows.push({id: id, value: obj});
        }

        let f = eval('(' + func.map.replace(/emit/g, '_emit_') + ')');

        for (let id in objects) {
            if (!objects.hasOwnProperty(id)) continue;
            if (params) {
                if (params.startkey && id < params.startkey) continue;
                if (params.endkey   && id > params.endkey)   continue;
            }
            if (objects[id]) {
                try {
                    f(objects[id]);
                } catch (e) {
                    console.log('Cannot execute map: ' + e.message);

                }
            }
        }
        // Calculate max
        if (func.reduce === '_stats') {
            let max = null;
            for (let i = 0; i < result.rows.length; i++) {
                if (max === null || result.rows[i].value > max) {
                    max = result.rows[i].value;
                }
            }
            if (max !== null) {
                result.rows = [{id: '_stats', value: {max: max}}];
            } else {
                result.rows = [];
            }
        }

        callback(null, result);
    }
    this._applyView = function (func, params, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this._applyView(func, params, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }

        if (options && options.acl) options.acl = null;

        if (typeof callback === 'function') {
            checkObjectRights(null, options, 'list', (err, options) => {
                if (err) {
                    if (typeof callback === 'function') callback(err);
                } else {
                    return _applyView(func, params, options, callback);
                }
            });
        }
    };

    function _getObjectView(design, search, params, options, callback) {
        if (objects['_design/' + design]) {
            if (objects['_design/' + design].views && objects['_design/' + design].views[search]) {
                _applyView(objects['_design/' + design].views[search], params, options, callback);
            } else {
                console.log('Cannot find search "' + search + '" in "' + design + '"');
                callback({status_code: 404, status_text: 'Cannot find search "' + search + '" in "' + design + '"'});
            }
        } else {
            console.log('Cannot find view "' + design + '"');
            callback({status_code: 404, status_text: 'Cannot find view "' + design + '"'});
        }
    }
    this.getObjectView = function (design, search, params, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.getObjectView(design, search, params, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }

        if (options && options.acl) options.acl = null;

        if (typeof callback === 'function') {
            checkObjectRights(null, options, 'list', (err, options) => {
                if (err) {
                    if (typeof callback === 'function') callback(err);
                } else {
                    return _getObjectView(design, search, params, options, callback);
                }
            });
        }
    };

    function _getObjectList(params, options, callback) {
        // return rows with id and doc
        let result = {
            rows: []
        };

        for (let id in objects) {
            if (!checkObject(id, options, ACCESS_READ)) continue;
            if (params) {
                if (params.startkey && id < params.startkey) continue;
                if (params.endkey   && id > params.endkey)   continue;
                if (!params.include_docs && id[0] === '_')   continue;
            }
            let obj = {id: id, value: clone(objects[id])};
            obj.doc = obj.value;

            if (options.sorted) {
                // insert sorted
                if (!result.rows.length) {
                    result.rows.push(obj);
                } else if (obj.id <= result.rows[0].id) {
                    result.rows.unshift(obj);
                } else if (obj.id >= result.rows[result.rows.length - 1].id) {
                    result.rows.push(obj);
                } else {
                    for (let t = 1; t < result.rows.length; t++) {
                        if (obj.id > result.rows[t - 1].id && obj.id <= result.rows[t].id) {
                            result.rows.splice(t, 0, obj);
                            break;
                        }
                    }
                }
            } else {
                result.rows.push(obj);
            }
        }
        callback(null, result);
    }
    this.getObjectList = function (params, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.getObjectList(params, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }

        if (options && options.acl) options.acl = null;

        if (typeof callback === 'function') {
            checkObjectRights(null, options, 'list', (err, options) => {
                if (err) {
                    if (typeof callback === 'function') callback(err);
                } else {
                    return _getObjectList(params, options, callback);
                }
            });
        }
    };

    this.getObjectListAsync = (params, options) => {
        return new Promise((resolve, reject) => {
            this.getObjectList(params, options, (err, arr) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(arr);
                }
            })
        });
    };

    function _extendObject(id, obj, options, callback) {
        if (!id || regCheckId.test(id)) {
            if (typeof callback === 'function') {
                callback(`Invalid ID: ${id}`);
            }
            return;
        }

        if (id === 'system.config' && obj && obj.common && objects[id] && objects[id].common && JSON.stringify(obj.common.defaultNewAcl) !== JSON.stringify(objects[id].common.defaultNewAcl)) {
            objects[id] = obj;
            return setDefaultAcl(() => {
                _extendObject(id, obj, options, callback);
            });
        }

        let oldObj;
        if (objects[id] && objects[id].nonEdit) {
            oldObj = Object.assign({}, objects[id])
        }

        objects[id] = objects[id] || {};
        objects[id] = extend(true, objects[id], obj);
        objects[id]._id = id;

        // add user default rights
        if (defaultNewAcl && !objects[id].acl) {
            objects[id].acl = Object.assign({}, defaultNewAcl);
            delete objects[id].acl.file;
            if (objects[id].type !== 'state') {
                delete objects[id].acl.state;
            }

            if (options.owner) {
                objects[id].acl.owner = options.owner;

                if (!options.ownerGroup) {
                    objects[id].acl.ownerGroup = null;
                    that.getUserGroup(options.owner, (user, groups /*, permissions */) => {
                        if (!groups || !groups[0]) {
                            options.ownerGroup = (defaultNewAcl && defaultNewAcl.ownerGroup) || SYSTEM_ADMIN_GROUP;
                        } else {
                            options.ownerGroup = groups[0];
                        }
                        _extendObject(id, obj, options, callback);
                    });
                    return;
                }
            }
        }

        if (defaultNewAcl && options.ownerGroup && objects[id].acl && !objects[id].acl.ownerGroup) {
            objects[id].acl.ownerGroup = options.ownerGroup;
        }

        if (oldObj && !tools.checkNonEditable(oldObj, objects[id])) {
            if (typeof callback === 'function') {
                callback('Invalid password for update of vendor information');
            }
            return;
        }

        publishAll('objects', id, objects[id]);

        if (typeof callback === 'function') {
            setImmediate(() => callback(null, {id: id, value: objects[id]}, id));
        }

        if (!configTimer) configTimer = setTimeout(saveConfig, 5000);
    }
    this.extendObject = function (id, obj, options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.extendObject(id, obj, options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }

        if (options && options.acl) options.acl = null;

        checkObjectRights(id, options, 2/*write*/, function (err, options) {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                return _extendObject(id, obj, options, callback);
            }
        });
    };

    this.extendObjectAsync = function (id, obj, options) {
        return new Promise((resolve, reject) => {
            this.extendObject(id, obj, options, err => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    };

    this.setConfig = this.setObject;

    this.delConfig = this.delObject;

    this.getConfig = this.getObject;

    this.getConfigs = this.getObjects;

    function _findObject(idOrName, type, options, callback) {
        if (!objects) {
            return callback('Not implemented');
        }

        // Assume it is ID
        if (objects[idOrName] && (!type || (objects[idOrName].common && objects[idOrName].common.type === type))) {
            callback(null, idOrName, objects[idOrName].common.name);
        } else {
            // Assume it is name
            for (let id in objects) {
                if (!checkObject(id, options, ACCESS_READ)) continue;
                if (objects[id].common &&
                    objects[id].common.name === idOrName &&
                    (!type || (objects[id].common && objects[id].common.type === type))) {
                    return callback(null, id, idOrName);
                }
            }
            callback(null, null, idOrName);
        }
    }

    this.findObject = function (idOrName, type, options, callback) {
        if (typeof type === 'function') {
            callback = type;
            options = null;
            type = null;
        }
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        if (!callback) {
            return new Promise((resolve, reject) => {
                this.findObject(idOrName, type, options, (err, id, idOrName) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(id);
                    }
                });
            });
        }

        if (options && options.acl) options.acl = null;

        if (typeof callback === 'function') {
            checkObjectRights(null, options, 'list', (err, options) => {
                if (err) {
                    if (typeof callback === 'function') callback(err);
                } else {
                    return _findObject(idOrName, type, options, callback);
                }
            });
        }
    };

    // can be called only from js-controller
    this.addPreserveSettings = function (settings) {
        if (typeof settings !== 'object') settings = [settings];

        for (let s = 0; s < settings.length; s++) {
            if (preserveSettings.indexOf(settings[s]) === -1) preserveSettings.push(settings[s]);
        }
    };

    function _destroyDB(options, callback) {
        if (fs.existsSync(objectsName)) {
            fs.unlinkSync(objectsName);
        }
        if (typeof callback === 'function') callback();
    }

    this.destroyDB = function (options, callback) {
        if (typeof options === 'function') {
            callback = options;
            options = null;
        }
        options = options || {};

        if (!callback) {
            return new Promise((resolve, reject) => {
                this.destroyDB(options, (err, obj) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(obj);
                    }
                });
            });
        }

        options.acl = null;

        checkObjectRights(null, options, ACCESS_WRITE, (err, options) => {
            if (err) {
                if (typeof callback === 'function') callback(err);
            } else {
                if (!options.acl.file.write) {
                    if (typeof callback === 'function') callback('permissionError');
                } else {
                    return _destroyDB(options, callback);
                }
            }
        });
    };

    function socketEvents(socket /*, user*/) {
        socket.on('writeFile', function (id, name, data, options, callback) {
            that.writeFile.apply(that, arguments);
        });

        socket.on('destroy', function (callback) {
            // client may not close DB
            if (typeof callback === 'function') callback();
            //that.destroy.apply(that, arguments);
        });

        socket.on('enableFileCache', function (enabled, options, callback) {
            that.enableFileCache.apply(that, arguments);
        });

        socket.on('readFile', function (id, name, params, options, callback) {
            that.readFile.apply(that, arguments);
        });

        socket.on('readDir', function (id, path, options, callback) {
            that.readDir.apply(that, arguments);
        });

        socket.on('unlink', function (id, name, options, callback) {
            that.unlink.apply(that, arguments);
        });

        socket.on('rename', function (id, oldName, newName, options, callback) {
            that.rename.apply(that, arguments);
        });

        socket.on('mkdir', function (id, dirname, callback) {
            that.mkdir.apply(that, arguments);
        });

        socket.on('chownFile', function (id, path, options, callback) {
            that.chownFile.apply(that, arguments);
        });

        socket.on('chmodFile', function (id, path, options, callback) {
            that.chmodFile.apply(that, arguments);
        });

        socket.on('rm', function (id, path, options, callback) {
            that.rm.apply(that, arguments);
        });

        socket.on('touch', function (id, path, options, callback) {
            that.touch.apply(that, arguments);
        });

        socket.on('subscribe', function (pattern, options, callback) {
            // it must be "this" and not "that"
            that.subscribe.apply(this, arguments);
        });

        socket.on('unsubscribe', function (pattern, options, callback) {
            // it must be "this" and not "that"
            that.unsubscribe.apply(this, arguments);
        });

        socket.on('getObjectView', function (design, search, params, options, callback) {
            that.getObjectView.apply(that, arguments);
        });

        socket.on('getObjectList', function (params, options, callback) {
            that.getObjectList.apply(that, arguments);
        });

        socket.on('extendObject', function (id, obj, options, callback) {
            that.extendObject.apply(that, arguments);
        });

        socket.on('setObject', function (id, obj, options, callback) {
            that.setObject.apply(that, arguments);
        });

        socket.on('delObject', function (id, options, callback) {
            that.delObject.apply(that, arguments);
        });

        socket.on('findObject', function (idOrName, type, options, callback) {
            that.findObject.apply(that, arguments);
        });

        socket.on('destroyDB', function (options, callback) {
            that.destroyDB.apply(that, arguments);
        });

        socket.on('getObject', function (id, options, callback) {
            that.getObject.apply(that, arguments);
        });

        socket.on('chownObject', function (pattern, options, callback) {
            that.chownObject.apply(that, arguments);
        });

        socket.on('chmodObject', function (pattern, options, callback) {
            that.chmodObject.apply(that, arguments);
        });

        socket.on('error', function (err) {
            log.error(namespace + ' ' + err);
        });
    }

    function initSocket(socket) {
        if (settings.auth) {
            let user = null;
            socketEvents(socket /*, user*/);
        } else {
            socketEvents(socket);
        }
    }

    function _initWebServer(settings, server) {

        try {
            if (settings.secure) {
                if (!settings.certificates) return;
                server.server = require('https').createServer(settings.certificates, function (req, res) {
                    res.writeHead(501);
                    res.end('Not Implemented');
                });
            } else {
                server.server = require('http').createServer(function (req, res) {
                    res.writeHead(501);
                    res.end('Not Implemented');
                });
            }
            server.server.listen(settings.port || 9001, (settings.host && settings.host !== 'localhost') ? settings.host : ((settings.host === 'localhost') ? '127.0.0.1' : undefined));
        } catch (e) {
            log.error(namespace + ' Cannot start inMem-objects on port ' + (settings.port || 9001) + ': ' + e.message);
            console.log('Cannot start inMem-objects on port ' + (settings.port || 9001) + ': ' + e.message);
            process.exit(24);
        }

        server.io = socketio.listen(server.server);

        if (settings.auth) {
            server.io.use(function (socket, next) {
                if (!socket.request._query.user || !socket.request._query.pass) {
                    console.log('No password or username!');
                    next(new Error('Authentication error'));
                } else {
                    next(new Error('Authentication error'));
                    // TODO
                    /*adapter.checkPassword(socket.request._query.user, socket.request._query.pass, function (res) {
                        if (res) {
                            console.log("Logged in: " + socket.request._query.user + ', ' + socket.request._query.pass);
                            return next();
                        } else {
                            console.log("Invalid password or user name: " + socket.request._query.user + ', ' + socket.request._query.pass);
                            next(new Error('Invalid password or user name'));
                        }
                    });*/
                }
            });
        }
        server.io.set('origins', '*:*');
        server.io.on('connection', initSocket);

        log.info(namespace + ' ' + (settings.secure ? 'Secure ' : '') + ' inMem-objects listening on port ' + (settings.port || 9001));
    }

    // Destructor of the class. Called by shutting down.
    this.destroy = function () {
        if (configTimer) saveConfig();

        saveFileSettings(true);

        if (server.io) {
            if (server.io.sockets && server.io.sockets.connected) {
                for (let s in server.io.sockets.connected) {
                    if (server.io.sockets.connected.hasOwnProperty(s)) {
                        delete server.io.sockets.connected[s];
                    }
                }
            }
            try {
                server.io.close();
            } catch (e) {
                console.log(e.message);
            }
        }
    };

    let __construct = (function () {
        if (fs.existsSync(objectsName)) {
            try {
                objects = JSON.parse(fs.readFileSync(objectsName).toString());
            } catch (e) {
                log.error(namespace + ' Cannot parse ' + objectsName + ': ' + e);
                if (fs.existsSync(objectsName + '.bak')) {
                    try {
                        objects = JSON.parse(fs.readFileSync(objectsName + '.bak').toString());
                    } catch (e) {
                        log.error(namespace + ' Cannot parse ' + objectsName + '.bak: ' + e);
                        objects = {};
                    }
                } else {
                    objects = {};
                }
            }
        } else if (fs.existsSync(objectsName + '.bak')) {
            try {
                objects = JSON.parse(fs.readFileSync(objectsName + '.bak').toString());
            } catch (e) {
                log.error(namespace + ' Cannot parse ' + objectsName + '.bak: ' + e);
                objects = {};
            }
        } else {
            objects = {};
        }

        // init default new acl
        if (objects['system.config'] && objects['system.config'].common && objects['system.config'].common.defaultNewAcl) {
            defaultNewAcl = Object.assign({}, objects['system.config'].common.defaultNewAcl);
        }

        // Create history directory
        // (!fs.existsSync(historyName)) fs.mkdirSync(historyName);

        change = settings.change || function (id /*, obj */) {
            log.silly(namespace + ' objects change: ' + id + ' ' + JSON.stringify(change));
        };

        // Check if directory exists
        objectsName = objectsName.replace(/\\/g, '/');
        /** @type {string|string[]} */
        let parts = objectsName.split('/');
        parts.pop();
        parts = parts.join('/');
        if (!fs.existsSync(parts)) fs.mkdirSync(parts);

        _initWebServer(settings.connection, server);

        if (settings.connected) {
            setImmediate(function () {
                settings.connected('InMemoryDB');
            });
        }
    })();
}

module.exports = ObjectsInMemServer;
