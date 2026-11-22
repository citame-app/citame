use std::fs::{DirBuilder, File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

/// Own the profile before opening sessions, replicas or the synchronization worker.
pub(crate) fn acquire(data_dir: &Path) -> io::Result<Option<File>> {
    let mut directory = DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    directory.mode(0o700);
    directory.create(data_dir)?;

    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600);
    // Keep the lock file even after exit. Unlinking a locked file could let two processes own
    // different inodes under the same pathname.
    let file = options.open(data_dir.join(".profile.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::acquire;

    #[test]
    fn the_same_profile_stays_unavailable_until_the_lock_is_released() {
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("profile");
        let owner = acquire(&profile).unwrap().unwrap();
        assert!(acquire(&profile).unwrap().is_none());

        drop(owner);
        assert!(profile.join(".profile.lock").is_file());
        assert!(acquire(&profile).unwrap().is_some());
    }

    #[test]
    fn separate_profiles_can_run_together() {
        let directory = tempfile::tempdir().unwrap();
        let first = acquire(&directory.path().join("one")).unwrap().unwrap();
        let second = acquire(&directory.path().join("two")).unwrap().unwrap();
        drop((first, second));
    }
}
