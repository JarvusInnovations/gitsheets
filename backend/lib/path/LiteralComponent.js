class LiteralComponent extends require('./BaseComponent.js') {
  render (record) {
    return this.name;
  }
}

module.exports = LiteralComponent;
