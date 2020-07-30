class BaseComponent
{
  constructor ({ name, prefix = null, suffix = null }) {
    this.name = name;

    if (prefix) {
      this.prefix = prefix;
    }

    if (suffix) {
      this.suffix = suffix;
    }
  }

  formatValue (value) {
    if (typeof value === 'function' || typeof value === 'undefined') {
      return undefined;
    }

    return `${this.prefix||''}${value}${this.suffix||''}`;
  }
}

module.exports = BaseComponent;
