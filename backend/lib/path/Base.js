class Base
{
  constructor ({ name, prefix = null, suffix = null }) {
    this.name = name;

    if (prefix) {
      this.prefix = prefix;
    }

    if (suffix) {
      this.suffix = suffix;
    }

    Object.freeze(this);
}
}

module.exports = Base;
