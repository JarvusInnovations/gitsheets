class ExpressionComponent extends require('./BaseComponent.js') {
  constructor () {
    super(...arguments);
    Object.freeze(this);
  }

  render (record) {
    throw new Exception('ExpressionComponent.render not yet implemented');
  }
}

module.exports = ExpressionComponent;
