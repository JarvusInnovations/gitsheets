class LiteralComponent extends require('./BaseComponent.js') {
  constructor () {
    super(...arguments);
    Object.freeze(this);
  }

  render (record) {
    return String(this.name);
  }
}

module.exports = LiteralComponent;
