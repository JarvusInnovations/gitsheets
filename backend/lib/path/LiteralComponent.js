class LiteralComponent extends require('./BaseComponent.js') {
  constructor () {
    super(...arguments);
    Object.freeze(this);
  }

  render (record) {
    return this.formatValue(this.name);
  }
}

module.exports = LiteralComponent;
