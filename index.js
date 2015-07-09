var fs = require('fs');
var path = require('path');
var url = require('url');
var childProcess = require('child_process');
var qs = require('qs');
var browserSync = require('browser-sync');
var postcss = require('postcss');
var browserify = require('browserify');
var babelify = require('babelify');
var handlebars = require('handlebars');
var highlight = require('highlight.js').highlight;
require('babel/register');

function matchPath(request, match) {
  var file = url.parse(request.url).pathname;
  if (match instanceof RegExp) {
    return match.test(file);
  }
  return match === file;
}

function handleError(server, request, response, error) {
  server.instance.logger.error('{red:%s}', error.stack || error);
  server.notify('Error compiling ' + request.url + ': ' + error.message);
  response.end(error.stack || String(error));
}

function serveHTML(server) {
  return function serveIndexMiddleware(request, response, next) {
    if (matchPath(request, '/') || matchPath(request, /\.html$/)) {
      var html = '';
      if (matchPath(request, '/')) {
        html = server.getFile('index.html');
      } else {
        html = server.getFile(request.url);
      }
      try {
        var json = JSON.parse(fs.readFileSync(server.getFile('package.json')));
        var config = json['component-devserver'] || {};
        if (!config.example) {
          throw new Error('devserver config must include example');
        }
        json.example = highlight('js', fs.readFileSync(server.getFile(config.example), 'utf8')).value;
        json.demo = renderServerSideDemo(server.getFile(config.example));
        json.readme = '';
        var readme = server.getFile('README.md');
        if (readme !== path.join(__dirname, 'README.md') && fs.existsSync(readme)) {
          json.readme = fs.readFileSync(readme);
        }
        var template = handlebars.compile(fs.readFileSync(html, 'utf8'));
        return response.end(template(json));
      } catch(error) {
        return handleError(server, request, response, error);
      }
    }
    next();
  };
}

function renderServerSideDemo(fileName) {
  var script = '' +
    'require("babel/register")({stage:0});' +
    'var React = require("react");' +
    'var example = require("' + fileName + '");' +
    'React.renderToStaticMarkup(example);';
  return childProcess.execSync('node -p \'' + script + '\'');
}

function serveCSS(server) {
  return function serveCSSMiddleware(request, response, next) {
    if (matchPath(request, /\.css$/)) {
      var file = server.getFile(request.url);
      if (file) {
        response.setHeader('Content-Type', 'text/css');
        return postcss()
          .use(require('cssnext')())
          .use(require('postcss-nesting')())
          .process(fs.readFileSync(file, 'utf8'), {
            from: file,
            map: true,
          })
          .then(function sendCSS(result) {
            response.end(result.css);
          })
          .catch(function cssError(error) {
            handleError(server, request, response, error);
          });
      }
    }
    next();
  };
}

function serveJS(server) {
  return function serveJSMiddleware(request, response, next) {
    if (!matchPath(request, /\.(?:js|es6)$/)) {
      return next();
    }
    var parsedUrl = url.parse(request.url);
    var parsedQuery = qs.parse(parsedUrl.query);
    var file = server.getFile(request.url);
    var isInNodeModules = matchPath(request, /node_modules/);
    var forceBrowserify = 'browserify' in parsedQuery;
    var shouldBrowserify = isInNodeModules === false || forceBrowserify;
    if (file && shouldBrowserify) {
      var browserifyTask = browserify({ debug: ('debug' in parsedQuery) });
      if ('expose' in parsedQuery) {
        browserifyTask.require(file, { expose: parsedQuery.expose });
      } else {
        browserifyTask.add(file);
      }
      if (parsedQuery.external && Array.isArray(parsedQuery.external) === false) {
        parsedQuery.external = [parsedQuery.external];
      }
      (parsedQuery.external || []).forEach(function externaliseModule(module) {
        browserifyTask.external(module);
      });
      if ('babelify' in parsedQuery) {
        browserifyTask.transform(babelify.configure({ stage: 0 }));
      }
      return browserifyTask
        .bundle()
        .on('error', handleError.bind(null, server, request, response))
        .pipe(response);
    }
    next();
  };
}

module.exports = function startServer(directory) {
  var server = browserSync.create();
  server.getFile = function getFile(fileUrl) {
    var file = url.parse(fileUrl).pathname;
    var dirs = this.instance.options.getIn(['server', 'baseDir']);
    if (this.instance.utils.isList(dirs)) {
      dirs = dirs.toArray();
    } else {
      dirs = [dirs];
    }
    return dirs.map(function transformDirToAbsolute(dir) {
      return path.join(dir, file);
    }).filter(fs.existsSync)[0];
  };
  server.init({
    logLevel: 'debug',
    logConnections: true,
    server: {
        baseDir: [directory, __dirname],
    },
    middleware: [serveHTML(server), serveCSS(server), serveJS(server)],
  });
  server.watch(path.join(__dirname, '*')).on('change', server.reload);
  server.watch(path.join(directory, '*')).on('change', server.reload);
  return server;
};
