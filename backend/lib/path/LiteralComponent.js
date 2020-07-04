class LiteralComponent extends require('./BaseComponent.js') {
  constructor () {
    super(...arguments);
    Object.freeze(this);
  }

  render (record) {
    return this.name;
  }
}

module.exports = LiteralComponent;
