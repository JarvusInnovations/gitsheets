class FieldComponent extends require('./BaseComponent.js') {
  constructor ({ recursive = false }) {
    super(...arguments);
    this.recursive = recursive;
    Object.freeze(this);
  }

  render (record) {
    return this.formatValue(record ? record[this.name] : undefined);
  }
}

module.exports = FieldComponent;
