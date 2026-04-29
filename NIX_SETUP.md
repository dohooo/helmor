# Nix Development Environment Setup

This project includes a `flake.nix` for reproducible development environments using Nix.

## Prerequisites

1. **Install Nix with flakes support:**
   ```bash
   # Official installer (recommended)
   curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
   
   # Or use the official Nix installer and enable flakes:
   sh <(curl -L https://nixos.org/nix/install)
   # Then add to ~/.config/nix/nix.conf:
   # experimental-features = nix-command flakes
   ```

2. **(Optional but recommended) Install direnv:**
   ```bash
   # macOS
   brew install direnv
   
   # Or via Nix
   nix profile install nixpkgs#direnv
   ```

   Then add to your shell config (`~/.bashrc` or `~/.zshrc`):
   ```bash
   eval "$(direnv hook bash)"  # for bash
   eval "$(direnv hook zsh)"   # for zsh
   ```

## Quick Start

### Option 1: Using direnv (Recommended)

The repository includes a `.envrc` file that automatically loads the Nix environment:

```bash
cd /path/to/helmor/calypso

# Allow direnv (first time only)
direnv allow

# Environment automatically loads when you cd into the directory!
# You should see: "🚀 Helmor development environment loaded!"
```

Now you can run commands directly:
```bash
bun install
bun run dev
```

### Option 2: Using nix develop

Without direnv, manually enter the Nix shell:

```bash
cd /path/to/helmor/calypso

# Enter the development shell
nix develop

# Now run your commands
bun install
bun run dev
```

### Option 3: One-off commands

Run commands without entering the shell:

```bash
nix develop --command bun run dev
nix develop --command bun run test
```

## What's Included

The Nix flake provides:

### Core Tools
- **Bun** - JavaScript/TypeScript runtime and package manager
- **Rust toolchain** - Stable Rust with `rust-analyzer`, `clippy`, `rust-src`
- **Node.js 20** - For tools that require Node
- **Git** - Version control
- **cargo-watch** - Watch Rust files for changes

### macOS-specific
- Apple SDK frameworks (Security, CoreServices, AppKit, WebKit, Cocoa, etc.)
- `libiconv`

### Linux-specific
- WebKitGTK 4.1
- GTK3, Cairo, GDK-Pixbuf, GLib
- DBus, OpenSSL 3, libsoup 3, librsvg
- Additional build tools (ATK, Pango)

### Environment Variables
- `RUST_BACKTRACE=1` - Verbose Rust error traces
- `RUST_LOG=info` - Rust logging level
- Properly configured `PKG_CONFIG_PATH` and `LD_LIBRARY_PATH` (Linux)

## Common Commands

Once in the environment (via `nix develop` or direnv):

```bash
# Setup
bun install                  # Install dependencies

# Development
bun run dev                  # Start Tauri + Vite dev server
bun run dev:analyze          # Dev mode with performance HUD

# Building
bun run build                # Build frontend bundle
bun run typecheck            # TypeScript type checking

# Linting
bun run lint                 # Run biome + clippy
bun run lint:fix             # Auto-fix lint issues

# Testing
bun run test                 # Run all test suites
bun run test:frontend        # Vitest (React components)
bun run test:sidecar         # Sidecar TypeScript tests
bun run test:rust            # Rust integration tests
bun run test:rust:update-snapshots  # Update insta snapshots
```

## Troubleshooting

### Flake not recognized
Ensure flakes are enabled in your Nix config (`~/.config/nix/nix.conf`):
```
experimental-features = nix-command flakes
```

### direnv not loading
1. Check that direnv is installed: `which direnv`
2. Check that the hook is in your shell config: `echo $DIRENV_*`
3. Allow the directory: `direnv allow`
4. Reload your shell: `exec $SHELL`

### "bun not found" in the Nix shell
1. Exit and re-enter the shell: `exit` then `nix develop`
2. Update flake inputs: `nix flake update`
3. Rebuild: `nix develop --rebuild`

### Rust compilation errors on macOS
Ensure Xcode Command Line Tools are installed:
```bash
xcode-select --install
```

### Linux: WebKitGTK errors
The flake includes WebKitGTK 4.1. If you still see errors:
```bash
# Update PKG_CONFIG_PATH manually
export PKG_CONFIG_PATH="$(nix develop --print-build-environment | grep PKG_CONFIG_PATH | cut -d= -f2-)"
```

## Updating Dependencies

Update Nix flake inputs to latest versions:
```bash
nix flake update
```

## Technical Details

### Nixpkgs Version
The flake uses **NixOS 24.11 (stable)** rather than `nixpkgs-unstable` to avoid breaking changes in Darwin SDK frameworks. If you need newer packages, you can override specific inputs, but the stable release provides a reliable base for Tauri development.

### Included Frameworks (macOS)
- Security, CoreServices, CoreFoundation
- Foundation, AppKit, WebKit, Cocoa
- libiconv

### Rust Toolchain
Stable Rust from rust-overlay with extensions:
- `rust-src` (for IDE tooling)
- `rust-analyzer` (LSP)
- `clippy` (linter)

## Advantages of Using Nix

1. **Reproducible builds** - Same environment on every machine
2. **No system pollution** - Dependencies isolated in Nix store
3. **Version pinning** - Flake lock ensures consistent versions
4. **Cross-platform** - Works on macOS, Linux, NixOS
5. **Easy onboarding** - New developers just run `nix develop`
6. **Automatic cleanup** - Old dependencies garbage collected

## Alternative: Docker (not recommended)

While a Dockerfile could provide similar isolation, Nix is preferred for Helmor because:
- Lower overhead (no container runtime)
- Native macOS support (important for Tauri)
- Better IDE integration
- Faster iteration (no rebuilds on `package.json` changes)

## Learn More

- [Nix Flakes Guide](https://nixos.wiki/wiki/Flakes)
- [direnv Documentation](https://direnv.net/)
- [Zero to Nix](https://zero-to-nix.com/) - Beginner-friendly tutorial
