class FieldComponent extends require('./BaseComponent.js') {
  render (record) {
    return record[this.name];
  }
}

module.exports = FieldComponent;
