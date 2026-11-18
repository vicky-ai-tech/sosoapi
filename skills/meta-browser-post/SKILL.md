---
name: meta-browser-post
description: Preview or publish one post to one or several social accounts, using the user's choice of native browser CLI or official SosoAPI CLI. Return per-platform results and confirmed links.
---

Use the bundled command `node SKILL_DIR/scripts/social-post.mjs`, where SKILL_DIR is this installed skill. For writing alone, return the draft in chat.

1. Keep the user's exact text, media and named destinations. Browser uses the signed-in native site and needs no SosoAPI account. API uses a registered SosoAPI workspace and connected accounts. Pass the requested route with `--via browser` or `--via api`. If neither is specified, use the saved choice. If the command reports `needs_route`, ask once. Use `route --via ROUTE` to change the saved choice.
2. Give one new post one unique key. Repeat `--to platform=account` for each intended account. Use `--text`, optionally `--image FILE` or `--video FILE`, and `--workspace NAME_OR_ID` if needed on the API route. For YouTube supply the video and approved title, visibility and audience (`--audience kids` or `--audience not-kids`). For an Instagram browser post supply one photo. Pass literal arguments, preserving punctuation and line breaks.
3. For a preview, run `preview`. To publish exact content the user has explicitly approved for these destinations now, run `publish` once. When the user asked for a draft or review, or you supplied new wording, show the final content, media and destinations and wait for approval. Example for two approved destinations:

   `node SKILL_DIR/scripts/social-post.mjs publish --via browser --key KEY --to threads=@example --to facebook="Example Page" --text "Exact approved caption" --image FILE`

4. Read the compact result. Share each confirmed link and identify pending, failed or unattempted accounts. For uncertainty, run `status --key KEY`. Reuse the same key after resolving a clearly specified pre-submit setup step. Keep pending submissions on their original route. Never invent a link or resubmit an uncertain post.
5. For browser setup, run the indicated `browser PLATFORM` command yourself in a separate terminal. Wait for `browser_open`; the user handles native sign-in and any 2FA. For an API sign-in request, start `npx -y sosoapi@0.5.25 auth login` and let the user choose the workspace. Ask only for the missing access, account or input. Keep session and post records outside Git.
