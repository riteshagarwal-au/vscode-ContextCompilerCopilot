# Publishing to VS Code Marketplace

Publisher: **riteshagarwal**
Marketplace: https://marketplace.visualstudio.com/manage/publishers/riteshagarwal

---

## First-time setup

No Azure subscription or DevOps PAT needed — upload is done manually via the Marketplace web UI.

---

## How to publish an update

1. **Make your changes** in `src/`

2. **Bump the version** in `package.json`:
   ```json
   "version": "0.1.1"
   ```
   *(Marketplace rejects a .vsix with the same version as an already-published one)*

3. **Build and package:**
   ```bash
   npm run build
   npx vsce package --allow-missing-repository --skip-license
   ```
   This produces `vscode-context-compiler-copilot-<version>.vsix`

4. **Upload to Marketplace:**
   - Go to https://marketplace.visualstudio.com/manage/publishers/riteshagarwal
   - Click **New extension** → **Visual Studio Code**
   - Drag and drop (or click to select) the `.vsix` file
   - Complete the reCAPTCHA if prompted
   - Click **Upload**

5. **Wait for verification** — Microsoft runs an automated check, usually a few minutes. Status shows as **Verifying** then goes **Public**.

---

## Install locally (without publishing)

```bash
npm run build
npx vsce package --allow-missing-repository --skip-license
code --install-extension vscode-context-compiler-copilot-<version>.vsix --force
```

Then reload VS Code: `Cmd+Shift+P` → **Developer: Reload Window**

---

## Extension details

| Field | Value |
|-------|-------|
| Publisher | `riteshagarwal` |
| Extension ID | `riteshagarwal.vscode-context-compiler-copilot` |
| Marketplace URL | https://marketplace.visualstudio.com/items?itemName=riteshagarwal.vscode-context-compiler-copilot |
| Entry point | `./dist/extension.js` |
| Build output | `./dist/` |
