class Query {
  prefix;
  complete;

  static render (template, query) {
    debugger;

    return new this();
  }

  constructor (prefix, complete) {
    this.prefix = prefix;
    this.complete = complete;
    Object.freeze(this);
  }
}

module.exports = Query;
