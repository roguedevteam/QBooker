// Wraps an async Express route handler so any rejected promise (e.g. a failed
// database connection) is forwarded to Express's error handler instead of
// crashing the process as an unhandled rejection.
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
