const express = require("express");

// Express 4 does NOT catch rejected promises from async route handlers. A throwing async
// handler never calls next(err), so it never reaches the error middleware in index.js --
// the client receives NO response at all and the request hangs until socket timeout.
// (process.on("unhandledRejection") keeps the process alive, which is exactly what makes
// this hard to spot: no crash, no error response, just a UI that spins forever.)
//
// asyncRouter() returns a normal express.Router whose handlers are auto-wrapped so any
// rejection is forwarded to next(err) and handled by the standard error middleware.
// Express 5 does this natively; this shim is the lower-risk path for now.
//
// Usage: replace `express.Router()` with `asyncRouter()` -- nothing else changes.

const WRAPPED_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "all", "use"];

function wrapHandler(handler) {
  if (typeof handler !== "function") return handler; // path strings, arrays, etc.
  // An express Router is itself a function; wrapping one would break mounting, so skip it.
  if (Array.isArray(handler.stack)) return handler;

  // Express identifies error-handling middleware by arity === 4. The wrapper MUST keep
  // that arity or Express silently reclassifies it as ordinary middleware.
  if (handler.length === 4) {
    return function wrappedErrorHandler(err, req, res, next) {
      return Promise.resolve(handler(err, req, res, next)).catch(next);
    };
  }

  return function wrappedHandler(req, res, next) {
    return Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function asyncRouter(options) {
  const router = express.Router(options);

  for (const method of WRAPPED_METHODS) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map(wrapHandler));
  }

  return router;
}

module.exports = { asyncRouter, wrapHandler };
