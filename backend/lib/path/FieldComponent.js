class FieldComponent extends require('./BaseComponent.js') {
  constructor ({ recursive = false }) {
    super(...arguments);
    this.recursive = recursive;
    Object.freeze(this);
  }

  render (record) {
    const value = record ? record[this.name] : undefined;
    return typeof value === 'function' ? undefined : value;
  }
}

module.exports = FieldComponent;
