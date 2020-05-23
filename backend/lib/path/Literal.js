class Literal extends require('./Base.js')
{
  render (record) {
    return this.name;
  }
}

module.exports = Literal;
