class CustomError extends Error {
  constructor (...args) {
    super(...args);
    Error.captureStackTrace(this, CustomError);
  }
};

class SerializationError extends CustomError {};
class ConfigError extends CustomError {};
class InvalidRefError extends CustomError {};

module.exports = {
  SerializationError,
  ConfigError,
  InvalidRefError,
};
