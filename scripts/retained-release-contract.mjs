// Reviewed selection, not user-supplied artifact IDs, versions or digests.
// Changing this descriptor requires a new review of the immutable origin.
export const retainedRelease = Object.freeze({
  selection: "vard68-upload-import-v1",
  repository: "f-tuma/vardum", repositoryId: 1342641877, ownerId: 261622887,
  commit: "20495967d0d256b12247720f8bbedbce568b54e1",
  tree: "3405984fa763ce78394c69cbc66e2c987501671d",
  branch: "codex/client-release-0.7",
  workflowId: 341146915, workflowPath: ".github/workflows/release.yml",
  runId: 38065972599, attempt: 1,
  artifactId: 11674484014,
  artifactName: "npm-20495967d0d256b12247720f8bbedbce568b54e1",
  archiveBytes: 52666,
  archiveSha256: "e119d2c87c683e2ce058251899c7c697bbd4d2e750dde8829c5dfabfa79ac590",
  createdAt: "2026-10-10T16:16:24Z", expiresAt: "2026-11-09T16:16:23Z",
  manifestBytes: 713,
  manifestSha256: "7af041283b7027a3f11e06dd500dedff01cf655aff7e311a49bf2cdb5b5a18ae",
  jobs: Object.freeze([
    Object.freeze({ id: 114253574750, name: "validate", conclusion: "success" }),
    Object.freeze({ id: 114256528624, name: "validate-download", conclusion: "success" }),
    Object.freeze({ id: 114256529780, name: "publish", conclusion: "skipped" }),
  ]),
  packages: Object.freeze([
    Object.freeze({ name: "@vardum/shared", version: "0.3.0", file: "vardum-shared-0.3.0.tgz", bytes: 3838,
      integrity: "sha512-bHffIFqZCMbfoeSyNlP28IcPbijCyOertBod+31MsPVyueAWMu937yJYWRM8ojYo7MsRhDytDoDA6bX3P89zLg==" }),
    Object.freeze({ name: "@vardum/cli", version: "0.7.0", file: "vardum-cli-0.7.0.tgz", bytes: 37773,
      integrity: "sha512-/SX23N3crcQeFC7wKqBl1XtPTsXIFuTq2HBvd2NTSNZ3mhWI1cWEwReCL3Vo3SOqWHU5RARU1Yr0RiMVyn4dmw==" }),
    Object.freeze({ name: "@vardum/mcp", version: "0.3.0", file: "vardum-mcp-0.3.0.tgz", bytes: 10098,
      integrity: "sha512-C85l10BwZlNnloGKnkZOvdAQwgwLdNIHucAdroTdy+vWQhitrBEpejR8ysVzAR2HD+PK9L8oEr/TIhOKr53KYQ==" }),
  ]),
  // No policy exception or npm-owner confirmation has been approved (VARD-45).
  publication: Object.freeze({ enabled: false, controllerRef: "refs/heads/main", environment: "npm" }),
});

export function selectRetainedRelease(selection) {
  if (selection !== retainedRelease.selection) throw new Error("Unknown reviewed retained-release selection");
  return retainedRelease;
}
export function expectedContract(candidate = retainedRelease) {
  return { expectedPackages: candidate.packages, expectedManifestSha256: candidate.manifestSha256,
    expectedManifestBytes: candidate.manifestBytes };
}
export const retainedFiles = Object.freeze(["release.json", ...retainedRelease.packages.map(pkg => pkg.file)]);
