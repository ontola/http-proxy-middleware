# koa-http2-proxy

Configure [http2-proxy](https://github.com/nxtedition/node-http2-proxy) middleware with ease for [koa](https://github.com/koajs/koa).

Based on [http-proxy-middleware](https://github.com/chimurai/http-proxy-middleware).

## TL;DR

Proxy requests to `http://www.example.org`

```javascript
var Koa = require('koa');
var proxy = require('koa-http2-proxy');
var app = new Koa();

// response
app.use(proxy({ target: 'http://www.example.org' }));

app.listen(3000);

// http://localhost:3000/foo/bar -> http://www.example.org/foo/bar
```

:bulb: **Tip:** Set the option `changeOrigin` to `true` for [name-based virtual hosted sites](http://en.wikipedia.org/wiki/Virtual_hosting#Name-based).

## Table of Contents

<!-- MarkdownTOC autolink=true bracket=round depth=2 -->

- [Install](#install)
- [Core concept](#core-concept)
- [Example](#example)
- [Context matching](#context-matching)
- [Options](#options)
- [Shorthand](#shorthand)
  - [app.use\(path, proxy\)](#appusepath-proxy)
- [WebSocket](#websocket)
  - [External WebSocket upgrade](#external-websocket-upgrade)
- [Tests](#tests)
- [Changelog](#changelog)
- [License](#license)

<!-- /MarkdownTOC -->

## Install

```javascript
$ npm install --save-dev koa-http2-proxy
```

## Core concept

Proxy middleware configuration.

#### proxy([context,] config)

```javascript
var proxy = require('koa-http2-proxy');

var apiProxy = proxy('/api', { target: 'http://www.example.org' });
//                   \____/   \_____________________________/
//                     |                    |
//                   context             options

// 'apiProxy' is now ready to be used as middleware in a server.
```

- **context**: Determine which requests should be proxied to the target host.
  (more on [context matching](#context-matching))
- **options.target**: target host to proxy to. _(protocol + host)_

(full list of [`koa-http2-proxy` configuration options](#options))

#### proxy(uri [, config])

```javascript
// shorthand syntax for the example above:
var apiProxy = proxy('http://www.example.org/api');
```

More about the [shorthand configuration](#shorthand).

## Example

```javascript
// include dependencies
var Koa = require('koa');
var proxy = require('koa-http2-proxy');

// proxy middleware options
var options = {
  target: 'http://www.example.org', // target host
  ws: true, // proxy websockets
  pathRewrite: {
    '^/api/old-path': '/api/new-path', // rewrite path
    '^/api/remove/path': '/path' // remove base path
  },
  router: {
    // when request.headers.host == 'dev.localhost:3000',
    // override target 'http://www.example.org' to 'http://localhost:8000'
    'dev.localhost:3000': 'http://localhost:8000'
  }
};

// create the proxy (without context)
var exampleProxy = proxy(options);

// mount `exampleProxy` in web server
var app = new Koa();
app.use(exampleProxy);
app.listen(3000);
```

## Context matching

Providing an alternative way to decide which requests should be proxied; In case you are not able to use the server's [`path` parameter](http://expressjs.com/en/4x/api.html#app.use) to mount the proxy or when you need more flexibility.

[RFC 3986 `path`](https://tools.ietf.org/html/rfc3986#section-3.3) is used for context matching.

```
         foo://example.com:8042/over/there?name=ferret#nose
         \_/   \______________/\_________/ \_________/ \__/
          |           |            |            |        |
       scheme     authority       path        query   fragment
```

- **path matching**

  - `proxy({...})` - matches any path, all requests will be proxied.
  - `proxy('/', {...})` - matches any path, all requests will be proxied.
  - `proxy('/api', {...})` - matches paths starting with `/api`

- **multiple path matching**

  - `proxy(['/api', '/ajax', '/someotherpath'], {...})`

- **wildcard path matching**

  For fine-grained control you can use wildcard matching. Glob pattern matching is done by _micromatch_. Visit [micromatch](https://www.npmjs.com/package/micromatch) or [glob](https://www.npmjs.com/package/glob) for more globbing examples.

  - `proxy('**', {...})` matches any path, all requests will be proxied.
  - `proxy('**/*.html', {...})` matches any path which ends with `.html`
  - `proxy('/*.html', {...})` matches paths directly under path-absolute
  - `proxy('/api/**/*.html', {...})` matches requests ending with `.html` in the path of `/api`
  - `proxy(['/api/**', '/ajax/**'], {...})` combine multiple patterns
  - `proxy(['/api/**', '!**/bad.json'], {...})` exclusion

  **Note**: In multiple path matching, you cannot use string paths and wildcard paths together.

- **custom matching**

  For full control you can provide a custom function to determine which requests should be proxied or not.

  ```javascript
  /**
   * @return {Boolean}
   */
  var filter = function(pathname, req) {
    return pathname.match('^/api') && req.method === 'GET';
  };

  var apiProxy = proxy(filter, { target: 'http://www.example.org' });
  ```

## Options

- **option.pathRewrite**: object/function, rewrite target's url path. Object-keys will be used as _RegExp_ to match paths.

  ```javascript
  // rewrite path
  pathRewrite: {'^/old/api' : '/new/api'}

  // remove path
  pathRewrite: {'^/remove/api' : ''}

  // add base path
  pathRewrite: {'^/' : '/basepath/'}

  // custom rewriting
  pathRewrite: function (path, req) { return path.replace('/api', '/base/api') }
  ```

- **option.router**: object/function, re-target `option.target` for specific requests.

  ```javascript
  // Use `host` and/or `path` to match requests. First match will be used.
  // The order of the configuration matters.
  router: {
      'integration.localhost:3000' : 'http://localhost:8001',  // host only
      'staging.localhost:3000'     : 'http://localhost:8002',  // host only
      'localhost:3000/api'         : 'http://localhost:8003',  // host + path
      '/rest'                      : 'http://localhost:8004'   // path only
  }

  // Custom router function
  router: function(req) {
      return 'http://localhost:8004';
  }
  ```

- **option.logLevel**: string, ['debug', 'info', 'warn', 'error', 'silent']. Default: `'info'`

- **option.logProvider**: function, modify or replace log provider. Default: `console`.

  ```javascript
  // simple replace
  function logProvider(provider) {
    // replace the default console log provider.
    return require('winston');
  }
  ```

  ```javascript
  // verbose replacement
  function logProvider(provider) {
    var logger = new (require('winston')).Logger();

    var myCustomProvider = {
      log: logger.log,
      debug: logger.debug,
      info: logger.info,
      warn: logger.warn,
      error: logger.error
    };
    return myCustomProvider;
  }
  ```

- **option.onError**: function, subscribe to http-proxy's `error` event for custom error handling.

  ```javascript
  function onError(err, ctx) {
    ctx.response.status = 500;
    ctx.response.body =
      'Something went wrong. And we are reporting a custom error message.';
  }
  ```

- **option.onProxyRes**: function, subscribe to http-proxy's `proxyRes` event.

  ```javascript
  function onProxyRes(proxyRes, ctx) {
    proxyRes.headers['x-added'] = 'foobar'; // add new header to response
    delete proxyRes.headers['x-removed']; // remove header from response
  }
  ```

- **option.onProxyReq**: function, subscribe to http-proxy's `proxyReq` event.

  ```javascript
  function onProxyReq(proxyReq, ctx) {
    // add custom header to request
    proxyReq.setHeader('x-added', 'foobar');
    // or log the req
  }
  ```

- **option.onUpgrade**: function, called before upgrading a websocket connection.

  ```javascript
  onUpgrade: async ctx => {
    // add session middleware to the websocket connection
    // see option.app
    await session(ctx, () => {});
  };
  ```

- **option.app**: koa app, used to generate a koa ctx to be used in onUpgrade. If left blank, a object containing only `req` will be used as context
- **option.headers**: object, adds [request headers](https://en.wikipedia.org/wiki/List_of_HTTP_header_fields#Request_fields). (Example: `{host:'www.example.org'}`)
- **option.target**: url string to be parsed with the url module
- **option.ws**: true/false: if you want to proxy websockets
- **option.xfwd**: true/false, adds x-forward headers
- **option.changeOrigin**: true/false, Default: false - changes the origin of the host header to the target URL
- **option.protocol**: Agent protocol ('http' or 'https'). Defaults to 'http'
- **option.proxyTimeout**: timeout (in millis) when proxy receives no response from target
- **option.proxyName**: Proxy name used for Via header

## Shorthand

Use the shorthand syntax when verbose configuration is not needed. The `context` and `option.target` will be automatically configured when shorthand is used. Options can still be used if needed.

```javascript
proxy('http://www.example.org:8000/api');
// proxy('/api', {target: 'http://www.example.org:8000'});

proxy('http://www.example.org:8000/api/books/*/**.json');
// proxy('/api/books/*/**.json', {target: 'http://www.example.org:8000'});

proxy('http://www.example.org:8000/api');
// proxy('/api', {target: 'http://www.example.org:8000'});
```

## WebSocket

```javascript
// verbose api
proxy('/', { target: 'http://echo.websocket.org', ws: true });

// shorthand
proxy('http://echo.websocket.org', { ws: true });

// shorter shorthand
proxy('ws://echo.websocket.org');
```

### External WebSocket upgrade

In the previous WebSocket examples, http-proxy-middleware relies on a initial http request in order to listen to the http `upgrade` event. If you need to proxy WebSockets without the initial http request, you can subscribe to the server's http `upgrade` event manually.

```javascript
var wsProxy = proxy('ws://echo.websocket.org');

var app = new Koa();
app.use(wsProxy);

var server = app.listen(3000);
server.on('upgrade', wsProxy.upgrade); // <-- subscribe to http 'upgrade'
```

## Tests

Run the test suite:

```bash
# install dependencies
$ yarn

# linting
$ yarn lint
$ yarn lint:fix

# building (compile typescript to js)
$ yarn build

# unit tests
$ yarn test

# code coverage
$ yarn cover
```

## Changelog

- [View changelog](https://github.com/ontola/koa-http2-proxy/blob/master/CHANGELOG.md)

## License

The MIT License (MIT)

Copyright for portions of this project are held by Steven Chim, 2015-2019 as part of [http-proxy-middleware](https://github.com/chimurai/http-proxy-middleware). All other copyright for this project are held by Ontola BV, 2019.
