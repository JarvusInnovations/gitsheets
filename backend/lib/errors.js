class CustomError extends Error {};
CustomError.prototype.status = 500;

class SerializationError extends CustomError {};
SerializationError.prototype.status = 422;

class ConfigError extends CustomError {};
ConfigError.prototype.status = 500;

class InvalidRefError extends CustomError {};
InvalidRefError.prototype.status = 404;

class MergeError extends CustomError {};
MergeError.prototype.status = 409;

module.exports = {
  SerializationError,
  ConfigError,
  InvalidRefError,
  MergeError,
};
