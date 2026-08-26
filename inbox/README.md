# Inbox

Drop CSV exports in this folder and the running server imports them within a few
seconds — no clicking required. Each file is moved to `processed/` once it has
been read, with a timestamp prefixed to the name.

This is the hook for automating the daily routine: point your download folder
here, or `cp`/`rsync` your exports in on a schedule.

The folder's contents are gitignored — imported files contain card and account
details.
