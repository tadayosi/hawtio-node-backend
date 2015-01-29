/// <reference path="../d.ts/node.d.ts" />
/// <reference path="../d.ts/express.d.ts" />
/// <reference path="../d.ts/form-data.d.ts" />
/// <reference path="../d.ts/request.d.ts" />
/// <reference path="../d.ts/logger.d.ts" />
/// <reference path="../d.ts/lodash.d.ts" />
/// <reference path="../d.ts/underscore.string.d.ts" />
/// <reference path="../d.ts/URI.d.ts"/>
var path = require('path');
var fs = require('fs');
var eventStream = require('event-stream');
var express = require('express');
var request = require('request');
var logger = require('js-logger');
var s = require('underscore.string');
var _ = require('lodash');
var uri = require('URIjs');
var tiny_lr = require('tiny-lr');
var liveReload = require('connect-livereload');
var body = require('body-parser');
var runningAsScript = require.main === module;
var configFile = process.env.HAWTIO_CONFIG_FILE || 'config.js';
// default config values
var config = {
    // server listen port
    port: 2772,
    // log level
    logLevel: logger.INFO,
    // path to mount the dyamic proxy
    proxy: '/proxy',
    // paths to connect to external services, an example config:
    // {
    //   proto: 'http',
    //   hostname: 'localhost',
    //   port: 8282,
    //   path: '/hawtio/jolokia',
    //   targetPath: '/hawtio/jolokia'
    // }
    //
    staticProxies: [],
    // directories to search for static assets
    staticAssets: [
        {
            path: '/',
            dir: '.'
        }
    ],
    fallback: null,
    liveReload: {
        enabled: false,
        port: 35729
    }
};
if (fs.existsSync(configFile)) {
    var conf = require(configFile);
    _.assign(config, conf);
}
logger.useDefaults(config.logLevel);
if (runningAsScript) {
    logger.get('hawtio-backend').info("Running as script");
}

/// <reference path="includes.ts" />
var HawtioBackend;
(function (HawtioBackend) {
    HawtioBackend.log = logger.get('hawtio-backend');
    HawtioBackend.app = express();
    var startupTasks = [];
    var listening = false;
    function addStartupTask(cb) {
        HawtioBackend.log.debug("Adding startup task");
        startupTasks.push(cb);
        if (listening) {
            cb();
        }
    }
    HawtioBackend.addStartupTask = addStartupTask;
    function setConfig(newConfig) {
        _.assign(config, newConfig);
    }
    HawtioBackend.setConfig = setConfig;
    var server = null;
    var lr = null;
    var lrServer = null;
    function reload() {
        return eventStream.map(function (file, callback) {
            if (lr) {
                lr.changed({
                    body: {
                        files: file.path
                    }
                });
            }
            return callback(null, file);
        });
    }
    HawtioBackend.reload = reload;
    function listen(cb) {
        var lrPort = config.liveReload.port || 35729;
        if (config.liveReload.enabled) {
            HawtioBackend.app.use(liveReload({ port: lrPort }));
        }
        listening = true;
        startupTasks.forEach(function (cb) {
            HawtioBackend.log.debug("Executing startup task");
            cb();
        });
        if (config.fallback) {
            HawtioBackend.app.use(function (req, res, next) {
                fs.createReadStream(config.fallback).pipe(res);
            });
        }
        server = HawtioBackend.app.listen(config.port, function () {
            if (config.liveReload.enabled) {
                lr = tiny_lr();
                lrServer = lr.listen(lrPort, function () {
                    HawtioBackend.log.info("Started livereload, port :", lrPort);
                });
            }
            cb(server);
        });
        return server;
    }
    HawtioBackend.listen = listen;
    function stop(cb) {
        if (lrServer) {
            lrServer.close(function () {
                HawtioBackend.log.info("Stopped livereload port");
            });
            lrServer = null;
        }
        if (server) {
            server.close(function () {
                listening = false;
                if (cb) {
                    cb();
                }
            });
            server = null;
        }
    }
    HawtioBackend.stop = stop;
    function getServer() {
        return server;
    }
    HawtioBackend.getServer = getServer;
    if (runningAsScript) {
        server = listen(function (server) {
            var host = server.address().address;
            var port = server.address().port;
            HawtioBackend.log.info("started at ", host, ":", port);
        });
    }
})(HawtioBackend || (HawtioBackend = {}));
(module).exports = HawtioBackend;

/// <reference path="init.ts" />
var HawtioBackend;
(function (HawtioBackend) {
    function proxy(uri, req, res) {
        function handleError(e) {
            res.status(500).end('error proxying to "' + uri + '": ' + e);
        }
        var r = request({ method: req.method, uri: uri, json: req.body });
        req.on('error', handleError).pipe(r).on('error', handleError).pipe(res).on('error', handleError);
    }
    function getTargetURI(options) {
        var target = new uri({
            protocol: options.proto,
            hostname: options.hostname,
            port: options.port,
            path: options.path
        });
        target.query(options.query);
        var targetURI = target.toString();
        HawtioBackend.log.debug("Target URI: ", targetURI);
        return targetURI;
    }
    HawtioBackend.addStartupTask(function () {
        var index = 0;
        config.staticProxies.forEach(function (proxyConfig) {
            index = index + 1;
            _.defaults(proxyConfig, {
                path: '/proxy-' + index,
                hostname: 'localhost',
                port: 80,
                proto: 'http',
                targetPath: '/proxy-' + index
            });
            HawtioBackend.log.debug("adding static proxy config: \n", proxyConfig);
            var router = express.Router();
            router.use('/', function (req, res, next) {
                var path = [s.rtrim(proxyConfig.targetPath, '/'), s.ltrim(req.path, '/')].join('/');
                var uri = getTargetURI({
                    proto: proxyConfig.proto,
                    hostname: proxyConfig.hostname,
                    port: proxyConfig.port,
                    path: path,
                    query: req.query
                });
                proxy(uri, req, res);
            });
            HawtioBackend.app.use(proxyConfig.path, router);
        });
    });
    // dynamic proxy
    var proxyRouter = express.Router();
    proxyRouter.param('proto', function (req, res, next, proto) {
        HawtioBackend.log.debug("requesting proto: ", proto);
        switch (proto.toLowerCase()) {
            case 'http':
            case 'https':
                next();
                break;
            default:
                res.status(406).send('Invalid protocol: "' + proto + '"');
        }
    });
    proxyRouter.param('hostname', function (req, res, next, hostname) {
        HawtioBackend.log.debug("requesting hostname: ", hostname);
        next();
    });
    proxyRouter.param('port', function (req, res, next, port) {
        HawtioBackend.log.debug("requesting port: ", port);
        var portNumber = s.toNumber(port);
        HawtioBackend.log.debug("parsed port number: ", portNumber);
        if (isNaN(portNumber)) {
            res.status(406).send('Invalid port number: "' + port + '"');
        }
        else {
            next();
        }
    });
    proxyRouter.use('/:proto/:hostname/:port/', function (req, res, next) {
        var uri = getTargetURI({
            proto: req.params.proto,
            hostname: req.params.hostname,
            port: req.params.port,
            path: req.path,
            query: req.query
        });
        proxy(uri, req, res);
    });
    HawtioBackend.addStartupTask(function () {
        HawtioBackend.log.debug("Setting dynamic proxy mount point: ", config.proxy);
        HawtioBackend.app.use(config.proxy, proxyRouter);
    });
})(HawtioBackend || (HawtioBackend = {}));

/// <reference path="init.ts"/>
var HawtioBackend;
(function (HawtioBackend) {
    function mountAsset(mount, dir) {
        HawtioBackend.app.use(mount, express.static(path.normalize(dir)));
    }
    HawtioBackend.mountAsset = mountAsset;
    HawtioBackend.addStartupTask(function () {
        config.staticAssets.forEach(function (asset) {
            HawtioBackend.log.info("Mounting static asset: ", asset);
            mountAsset(asset.path, asset.dir);
        });
    });
})(HawtioBackend || (HawtioBackend = {}));
