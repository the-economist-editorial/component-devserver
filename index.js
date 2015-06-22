var fs = require('fs');
var path = require('path');
var url = require('url');
var browserSync = require('browser-sync');
var postcss = require('postcss');
var browserify = require('browserify');
var babelify = require('babelify');
var React = require('react');
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

function serveIndex(server) {
  return function serveIndexMiddleware(request, response, next) {
    if (matchPath(request, '/')) {
      try {
        var json = JSON.parse(fs.readFileSync(server.getFile('package.json')));
        json.example = highlight('js', fs.readFileSync(server.getFile('example.js'), 'utf8')).value;
        json.demo = React.renderToStaticMarkup(require(server.getFile('example.js')));
        var template = handlebars.compile(fs.readFileSync(server.getFile('index.html'), 'utf8'));
        return response.end(template(json));
      } catch(error) {
        handleError(server, request, response, error);
      }
    }
    next();
  };
}

function serveCSS(server) {
  return function serveCSSMiddleware(request, response, next) {
    if (matchPath(request, /\.css$/)) {
      var file = server.getFile(request.url);
      if (file) {
        response.setHeader('Content-Type', 'text/css');
        try {
          return response.end(postcss()
            .use(require('postcss-nesting')())
            .use(require('cssnext')())
            .process(fs.readFileSync(file, 'utf8'), {
              from: file,
              map: true,
            }).css);
        } catch(error) {
          handleError(server, request, response, error);
        }
      }
    }
    next();
  };
}

function serveJS(server) {
  return function serveJSMiddleware(request, response, next) {
    if (matchPath(request, '/react.js')) {
      return browserify()
        .require('react')
        .bundle()
        .pipe(response);
    } else if (matchPath(request, /^(?!.*node_modules\/).*\.js$/)) {
      var file = server.getFile(request.url);
      if (file) {
        return browserify(file, { debug: true, expose: url.parse(request.url).pathname })
          .external('react')
          .require(file, { expose: url.parse(request.url).pathname })
          .transform(babelify.configure({ stage: 0 }))
          .bundle()
          .on('error', handleError.bind(null, server, request, response))
          .pipe(response);
      }
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
    middleware: [serveIndex(server), serveCSS(server), serveJS(server)],
  });
  server.watch(path.join(__dirname, '*')).on('change', server.reload);
  server.watch(path.join(directory, '*')).on('change', server.reload);
  return server;
};
