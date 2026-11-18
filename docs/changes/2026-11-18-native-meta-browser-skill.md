# Native Meta browser publishing / 直接喺 Meta 網站發帖

- Change: An installable skill and local CLI prepare, publish once, and check Facebook Page posts, Instagram feed photos and Threads posts through the native browser. The existing SosoAPI CLI remains available separately. The README includes Codex and Claude Code project installation commands. A public-file inventory and pre-push check cover the proposed Git history and index.
- Verification: Codex exercised the local CLI and browser on isolated native-composer fixtures. The checks cover all three destinations, identity and composer mismatches, media, cross-post controls, an uncertain submission and permalink recovery. The privacy test introduces synthetic private material and removes it in a later commit to verify detection throughout outgoing history.
- Limitations: The native websites control their layouts. A UI that cannot be verified returns a request for input. The fixtures use no live provider account. Live publishing, token savings on this workflow, and Claude Code execution are unverified.

- 改動：新增可安裝嘅 skill 同本機 CLI，直接喺原生瀏覽器處理 Facebook Page、Instagram 相片貼文同 Threads。可以檢查帳戶、發一次帖同跟進結果；原有 SosoAPI CLI 仍然可以獨立選用。README 提供 Codex 同 Claude Code 安裝指示，公開檔案清單同 pre-push 檢查會核對準備推送嘅 Git 歷史同暫存區。
- 驗證：Codex 喺隔離嘅瀏覽器模擬畫面測試三個平台、帳戶或視窗唔符合、相片、跨平台分享、提交結果未明同連結核對。私隱測試亦涵蓋先加入模擬敏感資料、再喺後續 commit 刪除嘅情況。
- 限制：原生網站可以改版。工具辨認唔到畫面就會停低要求處理。模擬測試冇使用真實平台帳戶；真發帖、呢條路徑嘅慳 token 數字同 Claude Code 執行仍待實測。
