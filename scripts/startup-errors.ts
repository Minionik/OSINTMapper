/** Actionable launcher messages, kept separate so failures can be tested safely. */
export function startupMessage(log: string, port: number): string {
  if (/EADDRINUSE|10048|address already in use/i.test(log))
    return `Port ${port} is occupied. Stop the old server or choose a different PORT, then open the launcher again.`;
  if (
    /EACCES|EPERM|permission denied|readonly database|unable to open database/i.test(
      log,
    )
  )
    return "The database folder could not be opened or written. Use a writable folder and check its permissions. Your existing database has not been discarded.";
  if (/database disk image is malformed|file is not a database/i.test(log))
    return "The database is damaged. Keep a copy, then restore a workspace backup or SQLite snapshot from data/backups.";
  if (/disk is full|ENOSPC/i.test(log))
    return "There is not enough disk space. Free space on the workspace drive, then start again.";
  return "The local workspace did not start. Use Node.js 24 or newer and inspect data/launcher.log for the startup error.";
}
