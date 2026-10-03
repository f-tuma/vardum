// Better Auth declares drizzle-kit for schema generation. The API generates
// schemas with its direct development dependency and runs checked-in migrations
// through drizzle-orm; this optional peer must not pull the CLI into production.
// Reassess this correction when changing Better Auth.
export const hooks = {
  readPackage(pkg) {
    if (pkg.name === "better-auth" && pkg.version === "1.7.1") {
      delete pkg.peerDependencies?.["drizzle-kit"];
      delete pkg.peerDependenciesMeta?.["drizzle-kit"];
    }
    return pkg;
  },
};
