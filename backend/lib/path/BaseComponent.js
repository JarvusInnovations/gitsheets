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
}

module.exports = BaseComponent;
