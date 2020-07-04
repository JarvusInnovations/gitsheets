class FieldComponent extends require('./BaseComponent.js') {
  constructor ({ recursive = false }) {
    super(...arguments);
    this.recursive = recursive;
    Object.freeze(this);
  }

  render (record) {
    return record ? record[this.name] : undefined;
  }
}

module.exports = FieldComponent;
