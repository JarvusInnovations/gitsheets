//! Commit messages and reading a commit back
//! (`specs/behaviors/transactions.md` "Reading a commit back"), plus the
//! first-parent ancestry check `repo.push({ to })` uses
//! (`specs/behaviors/push-sync.md` "Pushing part of a branch").

use holo_tree::ObjectId;

use crate::error::{Error, Result};

/// A commit message split the way gitsheets writes it.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ParsedMessage {
    pub subject: String,
    pub body: String,
    pub trailers: Vec<(String, String)>,
}

fn trailer_line(line: &str) -> Option<(String, String)> {
    let (key, rest) = line.split_once(':')?;
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let value = rest.strip_prefix(' ').unwrap_or(rest);
    Some((key.to_string(), value.to_string()))
}

/// Split a raw commit message into subject, body, and trailers. Trailers are
/// the last paragraph (after the last blank line) when every line of it is
/// `Key: value` with a key of letters, digits, and hyphens.
pub fn parse_message(raw: &str) -> ParsedMessage {
    let text = raw.replace("\r\n", "\n");
    let text = text.trim_end();
    let (rest, trailers) = match text.rfind("\n\n") {
        Some(idx) => {
            let candidate = &text[idx + 2..];
            let parsed: Option<Vec<(String, String)>> = if candidate.is_empty() {
                None
            } else {
                candidate.lines().map(trailer_line).collect()
            };
            match parsed {
                Some(t) => (&text[..idx], t),
                None => (text, Vec::new()),
            }
        }
        None => (text, Vec::new()),
    };
    let (subject, body) = match rest.split_once('\n') {
        Some((s, b)) => (s.to_string(), b.trim_start_matches('\n').trim_end().to_string()),
        None => (rest.to_string(), String::new()),
    };
    ParsedMessage {
        subject,
        body,
        trailers,
    }
}

fn commit_failed<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> Error + '_ {
    move |e| Error::CommitFailed {
        message: format!("{what}: {e}"),
    }
}

/// One commit, as `repo.readCommit` returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitInfo {
    pub hash: String,
    pub tree: String,
    /// Full hashes, first parent first.
    pub parents: Vec<String>,
    pub author: Signature,
    pub committer: Signature,
    pub subject: String,
    pub body: String,
    pub trailers: Vec<(String, String)>,
}

/// A commit signature with an ISO 8601 date in the commit's own offset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub date: String,
}

fn iso(seconds: i64, offset_seconds: i32) -> String {
    let local = seconds + offset_seconds as i64;
    let days = local.div_euclid(86_400);
    let rem = local.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    let sign = if offset_seconds < 0 { '-' } else { '+' };
    let abs = offset_seconds.unsigned_abs();
    format!(
        "{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}{sign}{:02}:{:02}",
        abs / 3600,
        (abs % 3600) / 60
    )
}

fn signature(sig: gix::actor::SignatureRef<'_>) -> Result<Signature> {
    let time = sig.time().map_err(commit_failed("signature time"))?;
    Ok(Signature {
        name: sig.name.to_string(),
        email: sig.email.to_string(),
        date: iso(time.seconds, time.offset),
    })
}

/// Read one commit (`rev` is any commit-ish).
pub fn commit_info(repo: &gix::Repository, rev: &str) -> Result<CommitInfo> {
    let id = repo
        .rev_parse_single(rev)
        .map_err(|e| Error::RefNotFound {
            message: format!("could not resolve '{rev}': {e}"),
        })?
        .object()
        .map_err(|e| Error::RefNotFound {
            message: format!("could not load '{rev}': {e}"),
        })?
        .peel_to_commit()
        .map_err(|e| Error::RefNotFound {
            message: format!("'{rev}' does not resolve to a commit: {e}"),
        })?
        .id;
    let commit = repo.find_commit(id).map_err(commit_failed("find commit"))?;
    let tree = commit.tree_id().map_err(commit_failed("commit tree"))?.detach();
    let parents: Vec<ObjectId> = commit.parent_ids().map(|p| p.detach()).collect();
    let message = commit
        .message_raw()
        .map_err(commit_failed("commit message"))?
        .to_string();
    let author = signature(commit.author().map_err(commit_failed("commit author"))?)?;
    let committer = signature(commit.committer().map_err(commit_failed("commit committer"))?)?;
    let parsed = parse_message(&message);
    Ok(CommitInfo {
        hash: id.to_string(),
        tree: tree.to_string(),
        parents: parents.iter().map(|p| p.to_string()).collect(),
        author,
        committer,
        subject: parsed.subject,
        body: parsed.body,
        trailers: parsed.trailers,
    })
}

/// [`is_first_parent_ancestor`] over two commit-ish specs; `ref_not_found`
/// when either does not resolve to a commit.
pub fn is_first_parent_ancestor_spec(repo: &gix::Repository, a: &str, tip: &str) -> Result<bool> {
    let resolve = |spec: &str| -> Result<ObjectId> {
        repo.rev_parse_single(spec)
            .ok()
            .and_then(|id| id.object().ok())
            .and_then(|o| o.peel_to_commit().ok())
            .map(|c| c.id)
            .ok_or_else(|| Error::RefNotFound {
                message: format!("'{spec}' does not resolve to a commit"),
            })
    };
    is_first_parent_ancestor(repo, resolve(a)?, resolve(tip)?)
}

/// Whether `a` is `tip` or reachable from it by first parents only.
pub fn is_first_parent_ancestor(repo: &gix::Repository, a: ObjectId, tip: ObjectId) -> Result<bool> {
    let mut cur = Some(tip);
    while let Some(id) = cur {
        if id == a {
            return Ok(true);
        }
        let commit = repo.find_commit(id).map_err(commit_failed("find commit"))?;
        cur = commit.parent_ids().next().map(|p| p.detach());
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_message_splits_subject_body_trailers() {
        let m = parse_message("Subject\n\nBody one\n\nBody two\n\nAction: x\nRef: ab\nRef: cd\n");
        assert_eq!(m.subject, "Subject");
        assert_eq!(m.body, "Body one\n\nBody two");
        assert_eq!(
            m.trailers,
            vec![
                ("Action".into(), "x".into()),
                ("Ref".into(), "ab".into()),
                ("Ref".into(), "cd".into())
            ]
        );
    }

    #[test]
    fn last_paragraph_that_is_not_all_trailers_is_body() {
        let m = parse_message("S\n\nnot a: trailer line\nplain line\n");
        assert_eq!(m.body, "not a: trailer line\nplain line");
        assert!(m.trailers.is_empty());
        let m = parse_message("Only: subject\n");
        assert_eq!(m.subject, "Only: subject");
        assert!(m.trailers.is_empty());
    }

    #[test]
    fn empty_message_with_trailers() {
        let m = parse_message("\n\nAction: x\n");
        assert_eq!(m.subject, "");
        assert_eq!(m.trailers, vec![("Action".into(), "x".into())]);
    }

    #[test]
    fn iso_dates_carry_the_offset() {
        assert_eq!(iso(0, 0), "1970-01-01T00:00:00+00:00");
        assert_eq!(iso(1_600_000_000, -5 * 3600), "2020-09-13T07:26:40-05:00");
    }
}
