# Releases

This repository can publish Community builds.

## Release Checklist

1. Run the web build:

   ```sh
   bun run build
   ```

2. Check the Tauri backend:

   ```sh
   cd src-tauri
   cargo check
   ```

3. Scan the repository for accidental secrets, credentials, hidden endpoints, or external service
   integrations that do not belong in the Community source tree.

4. Build desktop artifacts:

   ```sh
   bun run tauri build
   ```

5. Attach artifacts to a GitHub release.

## Versioning

Use semantic versions for Community releases. Keep `package.json`, `src-tauri/Cargo.toml`, and
`src-tauri/tauri.conf.json` aligned when cutting a release.
