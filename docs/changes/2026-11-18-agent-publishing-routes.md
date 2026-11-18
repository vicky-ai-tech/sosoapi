# Choose the browser or the SosoAPI CLI

## English

One project install lets an agent choose a browser session or the official SosoAPI CLI for a single destination or a batch. Each batch tracks individual submissions, survives an interrupted command and returns each confirmed link. The browser driver installs on first use. The README explains native sign-in, API registration and the two installation commands for Codex and Claude Code.

Codex exercised the skill against isolated browser and API fixtures. The new Threads and three-platform comparisons differed by at most 0.21% in total model tokens. The published measurements include each session’s input, cached input, output and timing. Live publishing, human registration and Claude Code execution are outside those measurements.

During the anonymous install check, the original command exited at the scope prompt when the terminal had no interactive input. The README now passes both installers their confirmation flags for a project-local install.

For a text-only Threads post, the browser can now recover a missing confirmation link by reading the account's profile and verifying the original post. It requires one match for the author, exact text and submission time. An ambiguous match stays unresolved and never triggers a second submission. An initial live test exposed a difference between signed-in and public layouts. The corrected skill recovered that post by its original key. On a fresh live test, one publish command returned the verified link with zero status calls. A signed-out check confirmed the author and text. All 49 repository tests passed.

## 廣東話

裝一次 skill，可以叫 agent 用瀏覽器或者官方 SosoAPI CLI，一次出一個或幾個平台。每個目的地獨立記錄結果；中途斷線可以用原本嘅 key 查返。README 列明兩條路嘅登入要求，同埋 Codex 同 Claude Code 各自嘅安裝指令。

今次用 Codex 喺隔離環境實測。發一條 Threads 同一張相出三個平台兩組對照，兩條路總 tokens 相差最多 0.21%。真實發帖、人手註冊同 Claude Code 執行仍待另行驗證。

用未登入 GitHub 嘅環境安裝時，發現舊指令喺冇互動輸入嘅 terminal 會停喺安裝範圍提示，退出後未裝到。README 已加返兩個確認參數，直接裝喺當前 project。

Threads 純文字帖文如果冇收到確認連結，Browser 而家會讀取帳戶主頁，再開啟原帖核對作者、完整文案同發佈時間。出現多個可能結果就保留待核實狀態，唔會重複出帖。首次實測發現登入前後嘅頁面結構有分別，修正後用原本嘅 key 搵返嗰條帖文。再用一條新帖實測，一次發佈指令即交返連結，毋須再查狀態；未登入亦睇到正確作者同內容。49 個測試全部通過。
