; Make the "Run application" and "Create desktop shortcut" checkboxes on the
; NSIS finish page unchecked by default. The Tauri installer template defines
; MUI_FINISHPAGE_RUN and MUI_FINISHPAGE_SHOWREADME unconditionally, so we can't
; undefine them from a hook; the *_NOTCHECKED variants are the supported way to
; opt users out by default. See https://github.com/tauri-apps/tauri/issues/15267
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
