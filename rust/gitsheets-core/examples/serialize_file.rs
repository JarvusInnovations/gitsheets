//! Print the fresh canonical serialization of one `.toml` file to stdout.
//! Usage: `cargo run -p gitsheets-core --example serialize_file -- <file>`
fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: serialize_file <file>");
    let input = std::fs::read_to_string(&path).expect("read");
    let value = gitsheets_core::parse(&input).expect("parse");
    print!("{}", gitsheets_core::serialize(&value).expect("serialize"));
}
