# Third-party Notices

June release artifacts may bundle third-party software. Keep upstream license
and notice files with redistributed source or binary builds.

## Hermes Agent

Production desktop builds bundle Hermes Agent from
<https://github.com/NousResearch/hermes-agent> at the commit pinned in
`src-tauri/src/hermes_bridge.rs`. Hermes Agent is licensed under the MIT
License.

The Hermes bundle script preserves upstream license and notice files under
`Contents/Resources/native/hermes/hermes-agent/` in the macOS app bundle and
writes an index at
`Contents/Resources/native/hermes/third_party_notices/THIRD_PARTY_NOTICES.txt`.

The pinned Hermes Agent tarball currently includes additional license or notice
files for bundled plugins and skills. Preserve those files when redistributing
the bundled runtime.
