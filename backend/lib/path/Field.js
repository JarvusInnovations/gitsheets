class Field extends require('./Base.js')
{
  render (record) {
    return record[this.name];
  }
}

module.exports = Field;
