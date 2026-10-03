import {
  backupSource,
  createBundle,
  requireEmptyBucket,
  restoreObjects,
  verifyBundle,
} from "./backup-bundle.js";
import { config } from "./config.js";
import { storage } from "./storage.js";

process.umask(0o077);
const [action, directory, source] = process.argv.slice(2);
try {
  if (!directory) throw new Error("A backup directory is required");
  if (action === "empty") {
    await requireEmptyBucket(storage, config.S3_BUCKET);
  } else {
    const manifest =
      action === "snapshot"
        ? await createBundle(
            storage,
            config.S3_BUCKET,
            directory,
            backupSource.parse(JSON.parse(source ?? "null")),
          )
        : action === "verify"
          ? await verifyBundle(directory)
          : action === "restore"
            ? await restoreObjects(storage, config.S3_BUCKET, directory)
            : null;
    if (!manifest)
      throw new Error("Expected snapshot, verify, restore or empty");
    console.log(
      JSON.stringify({
        action,
        objects: manifest.objects.length,
        objectBytes: manifest.objects.reduce((sum, item) => sum + item.size, 0),
        databaseBytes: manifest.database.size,
      }),
    );
  }
} finally {
  storage.destroy();
}
