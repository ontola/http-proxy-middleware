import { request as requestHttp } from 'http';
import { request as requestHttps } from 'https';

import * as finalhandler from 'finalhandler';
import * as proxy from 'http2-proxy';
import * as url from 'url';

import { createConfig } from './config-factory';
import * as contextMatcher from './context-matcher';
import { getArrow, getInstance } from './logger';
import * as PathRewriter from './path-rewriter';
import * as Router from './router';

export class KoaHttp2Proxy {
  private logger = getInstance();
  private config;
  private wsInternalSubscribed = false;
  private proxyOptions;
  private pathRewriter;

  constructor(context, opts) {
    this.config = createConfig(context, opts);
    this.proxyOptions = this.config.options;

    this.pathRewriter = PathRewriter.createPathRewriter(
      this.proxyOptions.pathRewrite
    ); // returns undefined when "pathRewrite" is not provided

    this.logger.info(
      `[HPM] Proxy created: ${this.config.context}  -> ${this.proxyOptions.target}`
    );
  }

  // https://github.com/Microsoft/TypeScript/wiki/'this'-in-TypeScript#red-flags-for-this
  public middleware = async (ctx, next) => {
    if (!this.shouldProxy(this.config.context, ctx.req)) {
      return next();
    }
    if (this.proxyOptions.ws === true) {
      // use initial request to access the server object to subscribe to http upgrade event
      this.catchUpgradeRequest(ctx.req);
    }

    return new Promise((resolve, reject) =>
      proxy.web(
        ctx.req,
        ctx.res,
        //@ts-ignore
        this.prepareProxyRequest(ctx, resolve),
        this.defaultWebHandler(ctx, resolve, reject)
      )
    );
  };

  private catchUpgradeRequest = req => {
    if (!this.wsInternalSubscribed) {
      req.connection.server.on('upgrade', this.handleUpgrade);
      // prevent duplicate upgrade handling;
      // in case external upgrade is also configured
      this.wsInternalSubscribed = true;
    }
  };

  private handleReq = ctx => (req, options) => {
    let proxyReq;
    const target = this.applyRouter(req, this.proxyOptions);
    const uri = url.parse(target);

    if (uri.protocol === 'http:') {
      proxyReq = requestHttp(options);
    } else {
      proxyReq = requestHttps(options);
    }
    

    if (!this.proxyOptions.changeOrigin) {
      proxyReq.setHeader('host', req.headers.host);
    }

    if (this.proxyOptions.headers) {
      for (const k of Object.keys(this.proxyOptions.headers)) {
        proxyReq.setHeader(k, this.proxyOptions.headers[k]);
      }
    }
    if (this.proxyOptions.xfwd) {
      proxyReq.setHeader('x-forwarded-for', req.socket.remoteAddress);
      const proto =
        req.headers['x-forwarded-proto'] ||
        (req.socket.encrypted ? 'https' : 'http');
      proxyReq.setHeader('x-forwarded-proto', proto);
      proxyReq.setHeader('x-forwarded-host', req.headers.host);
    }

    if (this.proxyOptions.onProxyReq) {
      this.proxyOptions.onProxyReq(proxyReq, ctx);
    }

    return proxyReq;
  };

  private handleRes = (ctx, resolve) => (_, __, proxyRes) => {
    if (this.proxyOptions.onProxyRes) {
      this.proxyOptions.onProxyRes(proxyRes, ctx);
    }

    ctx.response.status = proxyRes.statusCode;
    ctx.response.set(proxyRes.headers);
    ctx.response.body = proxyRes;

    if (resolve) {
      resolve();
    }
  };

  private handleUpgrade = async (req, socket, head) => {
    if (this.shouldProxy(this.config.context, req)) {
      const ctx = this.proxyOptions.app
        ? this.proxyOptions.app.createContext(req)
        : { req };
      if (this.proxyOptions.onUpgrade) {
        await this.proxyOptions.onUpgrade(ctx);
      }

      const activeProxyOptions = this.prepareProxyRequest(ctx, null);
      //@ts-ignore
      proxy.ws(req, socket, head, activeProxyOptions, this.defaultWSHandler);
      this.logger.info('[HPM] Upgrading to WebSocket');
    }
  };

  /**
   * Determine whether request should be proxied.
   *
   * @private
   * @param  {String} context [description]
   * @param  {Object} req     [description]
   * @return {Boolean}
   */
  private shouldProxy = (context, req) => {
    const path = req.originalUrl || req.url;
    return contextMatcher.match(context, path, req);
  };

  /**
   * Apply option.router and option.pathRewrite
   * Order matters:
   *    Router uses original path for routing;
   *    NOT the modified path, after it has been rewritten by pathRewrite
   * @param {Object} req
   * @return {Object} proxy options
   */
  private prepareProxyRequest = (ctx, resolve) => {
    // https://github.com/chimurai/http-proxy-middleware/issues/17
    // https://github.com/chimurai/http-proxy-middleware/issues/94
    ctx.req.url = ctx.req.originalUrl || ctx.req.url;

    // store uri before it gets rewritten for logging
    const originalPath = ctx.req.url;

    // Apply in order:
    // 1. option.router
    // 2. option.pathRewrite
    const target = this.applyRouter(ctx.req, this.proxyOptions);
    this.applyPathRewrite(ctx.req, this.pathRewriter);

    // debug logging for both http(s) and websockets
    if (this.proxyOptions.logLevel === 'debug') {
      const arrow = getArrow(
        originalPath,
        ctx.req.url,
        this.proxyOptions.target,
        target
      );
      this.logger.debug(
        '[HPM] %s %s %s %s',
        ctx.req.method,
        originalPath,
        arrow,
        target
      );
    }

    const uri = url.parse(target);

    return {
      hostname: uri.hostname,
      onReq: this.handleReq(ctx),
      onRes: this.handleRes(ctx, resolve),
      path: ctx.req.url,
      port: uri.port,
      protocol: uri.protocol,
      proxyName: this.proxyOptions.proxyName,
      proxyTimeout: this.proxyOptions.proxyTimeout,
      target
    };
  };

  // Modify option.target when router present.
  private applyRouter = (req, options) => {
    let newTarget;

    if (options.router) {
      newTarget = Router.getTarget(req, options);

      if (newTarget) {
        this.logger.debug(
          '[HPM] Router new target: %s -> "%s"',
          options.target,
          newTarget
        );
        return newTarget;
      }
    }

    return options.target;
  };

  // rewrite path
  private applyPathRewrite = (req, pathRewriter) => {
    if (pathRewriter) {
      const path = pathRewriter(req.url, req);

      if (typeof path === 'string') {
        req.url = path;
      } else {
        this.logger.info(
          '[HPM] pathRewrite: No rewritten path found. (%s)',
          req.url
        );
      }
    }
  };

  private defaultWebHandler = (ctx, resolve, reject) => (err, req, res) => {
    if (err) {
      this.logError(err, req);

      if (this.proxyOptions.onError) {
        this.proxyOptions.onError(err, ctx);
        resolve();
      } else {
        finalhandler(req, res)(err);
        reject();
      }
    } else {
      resolve();
    }
  };

  private defaultWSHandler = (err, req, socket) => {
    if (err) {
      this.logError(err, req);
      try {
        socket.destroy();
      } catch (e) {
        this.logError(e, req);
      }
    }
  };

  private logError = (err, req) => {
    const hostname =
      (req.headers && req.headers.host) || (req.hostname || req.host); // (websocket) || (node0.10 || node 4/5)
    const target = this.proxyOptions.target.host || this.proxyOptions.target;
    const errorMessage =
      '[HPM] Error occurred while trying to proxy request %s from %s to %s (%s) (%s)';
    const errReference =
      'https://nodejs.org/api/errors.html#errors_common_system_errors'; // link to Node Common Systems Errors page

    this.logger.error(
      errorMessage,
      req.url,
      hostname,
      target,
      err.code || err,
      errReference
    );
  };
}

function middleware(context, opts) {
  return new KoaHttp2Proxy(context, opts).middleware;
}

export default middleware;
