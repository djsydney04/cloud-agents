use crate::model::{Job, NewJob, now};
use anyhow::Result;
use rusqlite::{Connection, params};
use std::path::Path;

pub struct Store {
    db: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 1 {
            anyhow::bail!("State was created by a newer host; upgrade instead of downgrading");
        }
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
          PRAGMA user_version=1;",
        )?;
        Ok(Self { db })
    }
    pub fn list(&self) -> Result<Vec<Job>> {
        let mut stmt = self
            .db
            .prepare("SELECT body FROM jobs ORDER BY rowid DESC")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }
    pub fn get(&self, id: &str) -> Result<Job> {
        let s: String = self
            .db
            .query_row("SELECT body FROM jobs WHERE id=?1", [id], |r| r.get(0))?;
        Ok(serde_json::from_str(&s)?)
    }
    pub fn save(&self, j: &Job) -> Result<()> {
        self.db.execute("INSERT INTO jobs(id,body) VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET body=excluded.body", params![j.id,serde_json::to_string(j)?])?;
        Ok(())
    }
    pub fn insert(&self, request: NewJob) -> Result<Job> {
        let j = Job {
            id: uuid::Uuid::new_v4().to_string(),
            request,
            status: "queued".into(),
            created_at: now(),
            started_at: None,
            finished_at: None,
            exit_code: None,
            error: None,
        };
        self.save(&j)?;
        Ok(j)
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        self.db.execute("DELETE FROM jobs WHERE id=?1", [id])?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("db");
        let s = Store::open(&p).unwrap();
        let j = s
            .insert(serde_json::from_str(r#"{"provider":"smoke","prompt":"hi"}"#).unwrap())
            .unwrap();
        drop(s);
        let s = Store::open(&p).unwrap();
        assert_eq!(s.get(&j.id).unwrap().status, "queued");
        s.delete(&j.id).unwrap();
        assert!(s.list().unwrap().is_empty());
    }
}
