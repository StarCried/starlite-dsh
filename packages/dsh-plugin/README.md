# dsh-inochi2d-pet

DeepSeek Harness bundle for the Windows **DSH Companion** companion.

This package runs inside DSH under WSL2. It exposes only a short-lived,
token-protected status stream on IPv4 loopback and starts the separately
installed Windows companion through its registered URL protocol.

The alpha supports Windows 11 x64 with one DSH process. It does not send
prompts, tool arguments/results, error details, session identifiers, or paths
across the WSL boundary.

See the repository README for installation and compatibility details.

No prebuilt companion or npm package is published yet. For the current BYOM
source preview, build and install the Windows companion and packed bundle using
the repository development guide. After a prebuilt alpha is published, install
the unsigned Windows companion first, then in WSL2:

```bash
npm install -g --prefix "$HOME/.local" @deepseek-ai/dsh@latest
export PATH="$HOME/.local/bin:$PATH"
dsh plugin --profile web add dsh-inochi2d-pet@latest
dsh --profile web --dump-config
dsh web
```

If the Windows app is missing or a developer-preview DSH update changes the
required event contract, this bundle disables only the companion and lets DSH
continue. The bundle has no reverse API for controlling DSH.
