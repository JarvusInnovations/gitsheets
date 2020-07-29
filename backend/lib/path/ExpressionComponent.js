const vm = require('vm');

class ExpressionComponent extends require('./BaseComponent.js') {
  constructor () {
    super(...arguments);
    this.script = new vm.Script(this.name);
    Object.freeze(this);
  }

  render (record) {
    return this.script.runInNewContext(record);
  }
}

module.exports = ExpressionComponent;
