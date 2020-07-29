const vm = require('vm');

class ExpressionComponent extends require('./BaseComponent.js') {
  constructor () {
    super(...arguments);
    this.script = new vm.Script(this.name);
    Object.freeze(this);
  }

  render (record) {
    const value = this.script.runInNewContext(record);
    return typeof value === 'undefined' ? undefined : String(value);
  }
}

module.exports = ExpressionComponent;
