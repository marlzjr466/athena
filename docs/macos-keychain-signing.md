# macOS Keychain and Athena signing

Athena keeps provider credentials in macOS Keychain through a signed native credential service (`credentialService.m`). The former implementation used `@napi-rs/keyring` in the Electron main process; it did not use Electron safeStorage or keytar. The service and account names are stable; for example, ChatGPT records use service `com.athena.companion.chatgpt` and distinct account names for the account index and each account. A normal ChatGPT startup reads those records once per main-process instance. It does not rewrite or recreate them. A new empty installation no longer creates an empty index item just to display status.

macOS stores the app identity allowed to read a Keychain item in that item's access control list. The prior ad-hoc app builds had a code-hash based designated requirement, which changes when code is rebuilt. A saved **Always Allow** grant could therefore stop matching a later build. macOS checks both the trusted application requirement and a separate partition ACL. The audit on 2026-11-22 found that even the certificate-signed local build received a `cdhash:` partition: every rebuilt main application needed another grant despite the stable designated requirement. The ChatGPT account and index retained their original creation dates; the growing partition hash list, rather than credential recreation, explained the repeated prompts. The local signing path now keeps one self-signed certificate outside the repository at `~/Library/Application Support/AthenaBuild/signing` and requires the Athena bundle identifier plus that certificate's leaf fingerprint. The development Electron bundle is copied to ignored `out-dev` output, changed to Athena's existing bundle identifier, and signed with the same local certificate. Its helper apps are signed with that same certificate too. Provider secrets are now requested by `Contents/Resources/native/athena-credential-service`, a standalone signed executable with a stable CDHash independent of app resources/version. `prepare-credential-service.mjs` caches the signed executable under `out-dev/.credential-service` by native source, architecture, and parent requirement, then copies its exact bytes into each app. The signing hook verifies that existing signature and seals the file into the app; it does not re-sign the broker on each build. Changing the broker source or signing identity is an intentional security update and can require a new macOS authorization.

## Local development and packaging

Create the persistent local identity once, then use the existing scripts:

```sh
npm run setup:local-signing
npm run dev
npm run package
```

Do not delete or recreate the local signing directory after choosing **Always Allow**. If the identity is missing, Athena stops signing instead of silently reverting to ad-hoc identity. Local development and `release/mac-arm64/Athena.app` use the same stable certificate identity, while development credentials remain in the separate hashed development Keychain service.

## Developer ID releases

For distribution, make a valid **Developer ID Application** identity available in the macOS signing keychain and set `ATHENA_MACOS_SIGN_IDENTITY` to its exact identity name or fingerprint. Set notarization credentials in the build environment using one supported electron-builder set: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`; or `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`; or `APPLE_KEYCHAIN` and `APPLE_KEYCHAIN_PROFILE`. Then run `npm run dist:mac`. Secrets and API key contents must not be committed or stored in app settings.

The Developer ID path uses hardened runtime, Electron's required JIT entitlements, secure timestamping, and electron-builder notarization. Athena and its helper apps must use the same Apple Team ID. The app bundle identifier remains `com.athena.companion`; the designated requirement is verified against that identifier and the Developer ID team. This repository does not contain a Developer ID certificate, notarization credentials, or an Apple Team ID, so distribution signing and notarization can only be verified on a machine that supplies them.

## Re-authorizing an existing Keychain item

The first run after introducing the credential service can ask once for each existing item. Confirm the requester is `athena-credential-service` inside the intended Athena.app and the item starts with `com.athena.companion.`. Enter the login Keychain password in the macOS dialog if required and choose **Always Allow**. This adds only that signed service to the existing item; it does not grant access to every application. ChatGPT has an index and a distinct account record, so two initial dialogs are possible. Quit Athena fully and relaunch the same locally signed bundle. Then rebuild and relaunch using the same persistent local identity. The app does not suppress the macOS dialog or grant access to other applications.

If access is denied or the Keychain is locked, the credential read fails without deleting or rewriting the item. Restore normal Keychain access and restart Athena. An expired provider token is handled by that provider's existing reauthentication flow; it is separate from macOS Keychain authorization.


## Credential service boundaries

The native process validates its actual parent PID with Security.framework against Athena's bundle identifier and the expected signing certificate (or Apple Developer team for distribution) before reading stdin or accessing Keychain. Unrelated callers are rejected. Requests and results use inherited private pipes; secrets never appear in command arguments, logs, audit files, or plaintext fallback storage. Core dumps are disabled in the credential service. Electron renderer/GPU helpers do not access provider credentials.

Reads use the existing generic-password service/account pair. Only `errSecItemNotFound` means absence. Authorization/lock errors remain errors. Writes modify an existing item's data using `SecKeychainItemModifyAttributesAndData`; creation occurs only after a genuine not-found result. No ACL is rewritten programmatically. Existing provider removal actions retain their explicit delete behavior; no item is deleted to repair access.

`SecureCredentialEntries` coalesces each service/account read across the main-process lifetime, including failed reads, so status polls cannot spawn repeated authorization attempts. Successful writes refresh the in-memory entry. After restoring access to a locked/denied Keychain, restart Athena for a fresh read; existing credentials are preserved.

The shared service covers ChatGPT, OpenAI API, Copilot, Claude API, third-party inference, Brave search, and Academy integrations without changing their service/account identifiers. Cursor and Antigravity retain their official runtime authentication paths. No Claude subscription credential integration was introduced.

## Metadata-only audit

Run `node scripts/audit-macos-keychain.mjs release/mac-arm64/Athena.app artifacts/keychain-verification/audit.json` with normal macOS Keychain metadata access. It uses `codesign -dv`, `codesign -dr -`, strict verification, and `security dump-keychain -a` without `-d`, `-r`, `-g`, or `-w`. Only Athena item attributes and ACLs are retained. It also checks that an unrelated parent cannot invoke the credential service. `security find-generic-password -s com.athena.companion.chatgpt` can inspect the matching item's attributes without fetching its password.

A first-time fixture write and denial/restart behavior are covered by code-level tests. Live verification must separately record complete application quits, account recovery, real authorization observations, identical broker CDHashes across builds, and unchanged item creation metadata. A passing build alone is insufficient. Developer ID/notarization requires an Apple-issued identity; the local certificate has no Apple Team Identifier and is not notarizable.
