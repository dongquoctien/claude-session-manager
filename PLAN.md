# claude-session-manager — Development Plan

> Quản lý & mở nhanh mọi Claude Code conversation trải trên nhiều thư mục.
> Chọn 1 conversation → tự động mở terminal đúng folder → `claude --resume <id>`.

---

## 1. Vấn đề & Mục tiêu

**Vấn đề thực tế (đo trên máy người dùng):**
- **269 conversations** trải trên **44 project folders** trong `~/.claude/projects/`.
- Để resume, user phải: nhớ folder → mở terminal → `cd` → `claude` → `/resume` → tìm trong danh sách.
- Folder dễ quên; UUID không gợi nhớ; chuyển đổi giữa các phiên rất phiền.

**Mục tiêu:** một nơi duy nhất liệt kê tất cả conversation (có tiêu đề dễ đọc, lọc/tìm nhanh), chọn một cái là tự động bật terminal tại đúng `cwd` và chạy resume — không cần nhớ gì.

**Non-goals (giai đoạn đầu):**
- Không sửa/xoá nội dung conversation.
- Không đồng bộ cloud / multi-máy.
- Không thay thế `/resume` của Claude Code — chỉ là lớp điều hướng phía trên.

---

## 2. Sự thật về dữ liệu (đã xác minh, không phỏng đoán)

Vị trí: `~/.claude/projects/<slug-folder>/<sessionId>.jsonl`
Trên Windows: `C:\Users\<user>\.claude\projects\`

| Đặc điểm | Giá trị đo được | Ảnh hưởng thiết kế |
|----------|-----------------|--------------------|
| Tổng conversation | 269 file `.jsonl` | Cần search/lọc, không phân trang phức tạp |
| Tổng folder | 44 | Group theo `cwd` |
| File lớn nhất | **53.7 MB** | **Bắt buộc đọc streaming, giới hạn dòng — không load cả file** |
| Quét toàn bộ metadata | **~0.22s** | Đủ nhanh để quét mỗi lần mở app + watch |
| Có `cwd` | 265/269 (~99%) | Field tin cậy để biết folder mở |
| Có `gitBranch` | 265/269 (~99%) | Phân biệt worktree cùng repo |
| Có `aiTitle` | 186/269 (~70%) | **30% thiếu → cần fallback tiêu đề** |
| Có `lastPrompt` | 241/269 (~90%) | Dùng làm preview & fallback title |
| `aiTitle` xuất hiện ở dòng | min 0, max **182**, tb ~14 | **Phải quét tới ~200 dòng đầu để tìm, không chỉ dòng 1** |

**Các record type quan sát được trong `.jsonl`:**
- `ai-title` → `{ aiTitle, sessionId }` — tiêu đề do AI đặt.
- `last-prompt` → `{ lastPrompt, leafUuid, sessionId }` — prompt gần nhất.
- `summary` → `{ summary }` — đôi khi có.
- `user` / `assistant` → `{ message, cwd, gitBranch, version, timestamp, sessionId }`.
- `permission-mode`, `attachment`, `queue-operation` — bỏ qua.

**Lệnh resume đã xác minh:**
```
claude -r <sessionId>          # hoặc --resume <sessionId>
claude --resume <id> --fork-session   # (tuỳ chọn) tạo session mới khi resume
```
Chạy lệnh này **trong đúng `cwd`** của conversation.

**Mở terminal đã xác minh có sẵn (`wt.exe` tồn tại):**
```
wt.exe -d "<cwd>" claude --resume <sessionId>
```

---

## 3. Quyết định kiến trúc

**Stack:** Node.js + TypeScript. Core viết một lần (TS), dùng chung cho CLI + web.
- Không cần cài thêm gì (máy đã có Node v25 + npm). Không cần compiler C++/Rust.
- Phạm vi hiện tại: **CLI + Web**. Desktop (`.exe`) để ngỏ — vì core đã là JS nên bọc Electron sau này rất dễ, không phải viết lại logic.

### Ràng buộc bảo mật bắt buộc (quan trọng)
> Trình duyệt **không** đọc được `~/.claude/projects` và **không** spawn được terminal (sandbox).
> ⇒ Bản **web bắt buộc có một backend nhỏ (local agent Node)** làm cầu nối.
> ⇒ Agent chỉ bind `127.0.0.1`, dùng token cục bộ, chỉ chạy đúng lệnh `claude --resume`.

### Ranh giới module → đây là chìa khoá để chia sẻ code

```
┌──────────────────────────────────────────────┐
│  core (TS, package nội bộ)  — KHÔNG phụ thuộc UI │
│  • scan ~/.claude/projects                     │
│  • parse .jsonl (streaming, giới hạn dòng)     │
│  • model: Session { id, title, cwd, branch,    │
│            lastPrompt, mtime, size, project }   │
│  • title resolver (aiTitle → lastPrompt →      │
│            first user msg → "Untitled")         │
│  • launcher: build & spawn lệnh mở terminal     │
└───────────────┬───────────────┬────────────────┘
                │               │
         CLI (Node)        local agent (Node, web mode)
         csm bin           HTTP, bind 127.0.0.1,
                │          token cục bộ, CORS chặt
                │               │
                │               │
                │         web UI (tĩnh, fetch localhost:PORT)
                │
        (sau này) Electron bọc cùng UI → desktop .exe
```

Cùng một package `core` (TS) phục vụ cả CLI lẫn local agent ⇒ logic đọc dữ liệu & launch viết **một lần**. Khi thêm Electron, core tái sử dụng nguyên vẹn.

---

## 4. Roadmap theo phase (mỗi phase đều cho ra thứ chạy được)

### Phase 1 — Core engine (CLI chạy được ngay) ★ nền tảng
Mục tiêu: chứng minh đọc dữ liệu + mở terminal hoạt động end-to-end, qua CLI, trước khi đụng UI.

- [ ] `core` (TS): scanner + parser streaming (giới hạn ~200 dòng đầu + đọc mtime/size).
- [ ] Title resolver với fallback 4 tầng.
- [ ] Group theo project (`cwd`), sort theo mtime giảm dần.
- [ ] Launcher: detect `wt.exe`, fallback PowerShell `Start-Process`; build lệnh `claude --resume`.
- [ ] CLI `csm` (bin Node): `csm list`, `csm list --json`, `csm open <id>`, `csm search <kw>`.
- [ ] Test với dữ liệu thật 269 file; bench < 0.5s.
- **Mốc nghiệm thu:** `csm open <id>` mở đúng terminal, đúng folder, resume đúng conversation.

### Phase 2 — Web UI trên browser
- [ ] `agent` (Node HTTP): `GET /sessions`, `GET /sessions?q=`, `POST /open {id}`. Chỉ bind `127.0.0.1`, token cục bộ chống CSRF, CORS chỉ cho origin của chính nó.
- [ ] Web UI: ô search (fuzzy), danh sách group theo folder, mỗi item hiện title + branch + "x giờ trước" + nút Open.
- [ ] Auto-refresh khi file thay đổi (file-watch hoặc poll nhẹ vì quét chỉ 0.22s).
- **Mốc nghiệm thu:** mở browser → tìm → bấm Open → terminal bật lên đúng phiên.

### Phase 3 — Desktop app (để ngỏ, Electron)
> Chỉ làm khi thực sự cần một `.exe` double-click chạy. Core đã là TS nên tái dùng nguyên vẹn.
- [ ] Bọc cùng web UI bằng Electron; main-process gọi thẳng `core`.
- [ ] Cửa sổ gọn, nhớ kích thước; tray icon (tuỳ chọn).
- [ ] Build `.exe` (electron-builder). Kỳ vọng ~150MB.
- [ ] Phím tắt global mở app (tuỳ chọn, ví dụ Ctrl+Alt+C).
- **Mốc nghiệm thu:** double-click `.exe` → app chạy không cần terminal.

### Phase 4 — Polish
- [ ] Favorite / pin conversation hay dùng.
- [ ] Lọc theo project, theo branch, theo "đụng tới trong 7 ngày".
- [ ] Hiển thị preview lastPrompt khi hover/chọn.
- [ ] Tuỳ chọn `--fork-session` (resume nhưng tạo session mới).
- [ ] Phát hiện & ẩn conversation trong folder đã xoá (cwd không còn tồn tại) — hoặc đánh dấu "orphan".
- [ ] Đa nền tảng: macOS (`Terminal.app`/iTerm) & Linux (x-terminal-emulator) cho launcher.

---

## 5. Rủi ro & cách xử lý

| Rủi ro | Xử lý |
|--------|-------|
| File 53MB làm chậm/treo | Đọc streaming, cap số dòng, đọc mtime từ metadata thay vì nội dung |
| 30% conversation thiếu `aiTitle` | Title resolver 4 tầng: aiTitle → lastPrompt(rút gọn) → first user msg → "Untitled · <ngày>" |
| Format `.jsonl` của Claude Code đổi trong tương lai | Parser chịu lỗi: bỏ qua dòng/field lạ, không crash; pin field theo `type` |
| `.exe` Electron nặng (~150MB) | Chấp nhận được với tool nội bộ; nếu cần nhẹ sau này mới cân nhắc Tauri |
| Web mode bị lạm dụng spawn lệnh | Agent chỉ bind 127.0.0.1 + token cục bộ; chỉ chạy đúng `claude --resume`, không nhận lệnh tuỳ ý |
| `cwd` trỏ tới folder đã xoá | Kiểm tra tồn tại trước khi mở; báo "orphan" thay vì lỗi |
| Không có `wt.exe` | Fallback `Start-Process powershell` |
| Đường dẫn có khoảng trắng / Unicode (tiếng Việt) | Quote tham số; dùng UTF-8; test sẵn với path tiếng Việt |

---

## 6. Cấu trúc thư mục dự kiến

```
claude-session-manager/
├─ packages/
│  ├─ core/              # TS: scan + parse + launch (chia sẻ)  ← Phase 1
│  ├─ cli/               # bin `csm`                            ← Phase 1
│  ├─ agent/             # local HTTP agent (web mode)          ← Phase 2
│  └─ ui/                # web UI tĩnh, fetch localhost          ← Phase 2
│  └─ desktop/           # Electron wrapper (để ngỏ)            ← Phase 3
├─ PLAN.md               # tài liệu này
└─ README.md
```
> npm workspaces (monorepo). `cli`, `agent`, `desktop` đều `import` từ `core`.

---

## 7. Bước tiếp theo

Bắt đầu **Phase 1 — Core engine**. Kết thúc Phase 1 đã có thứ dùng được hằng ngày (CLI), trước khi đầu tư UI.
