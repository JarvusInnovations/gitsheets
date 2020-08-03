const vm = require('vm');
const notDefinedErrorRe = / is not defined$/;

class ExpressionComponent extends require('./BaseComponent.js') {
  constructor () {
    super(...arguments);
    this.script = new vm.Script(this.name);
    Object.freeze(this);
  }

  render (record) {
    try {
      return this.formatValue(this.script.runInNewContext(record));
    } catch (err) {
      if (notDefinedErrorRe.test(err.message)) {
        // treat expressions failing due to undefined factors as un-renderable
        return undefined;
      }

      // any other error should be fatal
      throw err;
    }
  }
}

module.exports = ExpressionComponent;
