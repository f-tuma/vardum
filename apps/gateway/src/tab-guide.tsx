import type { ReactNode } from "react";

const guides = {
  "vard-files": {
    title: "Choose the files your project needs",
    content: (
      <>
        <p>
          An asset is a source file in your workspace. A Vard maps those sources
          to files in one project.
        </p>
        <ol>
          <li>
            Choose <strong>Add asset</strong> and set a path relative to your
            project root, such as <code>public/logo.svg</code>.
          </li>
          <li>
            Follow the latest ready version or pin a specific version. Image
            transformations create a variant; they leave the source unchanged.
          </li>
          <li>
            Save the output, check <strong>Preview</strong>, then open{" "}
            <strong>CLI config</strong> to pull it into your project.
          </li>
        </ol>
        <p>
          Writable outputs allow <code>vardum push</code> to upload local edits
          as a new source version. Pinned and transformed outputs are read-only.
        </p>
      </>
    ),
  },
  "vard-folders": {
    title: "Include a folder recursively",
    content: (
      <>
        <p>
          A rule maps a workspace folder to a project folder. For example,{" "}
          <code>brand/</code> → <code>public/brand/</code> maps{" "}
          <code>brand/icons/logo.svg</code> to{" "}
          <code>public/brand/icons/logo.svg</code>.
        </p>
        <ol>
          <li>
            Add source and output prefixes ending in <code>/</code>. An empty
            prefix means the workspace or project root.
          </li>
          <li>
            Save rules and check <strong>Preview</strong>. Only ready originals
            are included; generated files are read-only.
          </li>
          <li>
            Run <code>vardum status --delete</code> to review an update, then{" "}
            <code>vardum pull --delete</code> if stale tracked files should be
            removed.
          </li>
        </ol>
        <p>
          Rules do not sync projects in the background. A pull without{" "}
          <code>--delete</code> leaves stale files on disk and drops their
          tracking; a later pull cannot clean them up automatically.
        </p>
      </>
    ),
  },
  "vard-config": {
    title: "Connect a project and keep builds repeatable",
    content: (
      <>
        <ol>
          <li>
            Use Node.js 22 or newer. The setup command installs an exact CLI
            version with support for <code>pull --frozen</code>.
          </li>
          <li>
            Choose <strong>Copy setup</strong> and run the command in your
            project root. It installs the CLI, runs <code>vardum init</code>
            with this Vard's values, opens browser login and pulls your files.
          </li>
          <li>
            Review the downloaded files and commit <code>vardum.json</code>,{" "}
            <code>.vardum.lock</code>, <code>package.json</code> and your npm
            lockfile.
          </li>
          <li>
            In CI, supply a read-only key as the <code>VARDUM_API_KEY</code>{" "}
            secret and run <code>vardum pull --frozen --json</code>.
          </li>
        </ol>
        <p>
          Normal pull intentionally updates project assets.{" "}
          <code>vardum update</code> updates the CLI itself. Frozen builds still
          need retained, reachable versions; renaming source keys or deleting
          assets can break old snapshots.
        </p>
      </>
    ),
  },
  "workspace-domain": {
    title: "Use your own delivery hostname",
    content: (
      <>
        <ol>
          <li>
            Save a hostname you control, such as <code>assets.example.com</code>
            .
          </li>
          <li>
            Add the displayed TXT verification record and CNAME at your DNS
            provider, then verify.
          </li>
          <li>
            Have your deployment administrator configure routing and an HTTPS
            certificate for that hostname.
          </li>
        </ol>
        <p>
          DNS verification proves ownership; it does not provision HTTPS.
          Private browser previews keep using the app hostname so your session
          works. The standard delivery path remains available.
        </p>
      </>
    ),
  },
  "workspace-keys": {
    title: "Connect automation to this workspace",
    content: (
      <>
        <ol>
          <li>
            Give each integration its own key. Choose read-only access for CI
            downloads; write access also allows uploads, deletion and
            publishing.
          </li>
          <li>
            Copy the secret when it is created and store it in your CI or
            application secret store.
          </li>
          <li>
            For the CLI, use <code>VARDUM_API_KEY</code>. For interactive work,{" "}
            <code>vardum login</code> creates a key through your browser.
          </li>
        </ol>
        <p>
          Keys are scoped to this workspace. Never commit them or put them in
          URLs. Revoke unused keys here; signing out a browser does not revoke
          CLI keys.
        </p>
      </>
    ),
  },
} satisfies Record<string, { title: string; content: ReactNode }>;

export type TabGuideTopic = keyof typeof guides;

export function TabGuide({ topic }: { topic: TabGuideTopic }) {
  const guide = guides[topic];
  return (
    <details className="tab-guide">
      <summary>Quick guide</summary>
      <div className="tab-guide-content">
        <h2>{guide.title}</h2>
        {guide.content}
      </div>
    </details>
  );
}
