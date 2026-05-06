{
  description = "Helmor - Local-first desktop app development environment";

  inputs = {
    # Use 24.11 stable - last known release with working Darwin SDK
    # Note: 25.11 exists but has breaking Darwin SDK changes as of 2026-04
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    # Keep nixpkgs-unstable available for bleeding-edge packages if needed
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };
        # Make unstable packages available if needed
        pkgs-unstable = import nixpkgs-unstable {
          inherit system;
        };

        # Use stable Rust toolchain
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" "clippy" ];
        };

        # Common build inputs for all platforms
        # Note: To use a package from unstable, use pkgs-unstable.packageName
        # Example: pkgs-unstable.bun (if you need bleeding edge)
        commonBuildInputs = with pkgs; [
          # Bun runtime (JavaScript/TypeScript)
          bun

          # Rust toolchain
          rustToolchain
          cargo-watch

          # Build essentials
          pkg-config
          openssl

          # Git (for version control operations)
          git

          # Node.js (some tools may need it)
          nodejs_20
        ];

        # Platform-specific dependencies
        darwinInputs = with pkgs; [
          # macOS-specific frameworks and tools
          libiconv
        ] ++ (with pkgs.darwin.apple_sdk.frameworks; [
          Security
          CoreServices
          CoreFoundation
          Foundation
          AppKit
          WebKit
          Cocoa
        ]);

        linuxInputs = with pkgs; [
          # Linux-specific Tauri dependencies
          webkitgtk_4_1
          gtk3
          cairo
          gdk-pixbuf
          glib
          dbus
          openssl_3
          librsvg
          libsoup_3

          # Additional Linux build tools
          atk
          pango
        ];

        buildInputs = commonBuildInputs
          ++ pkgs.lib.optionals pkgs.stdenv.isDarwin darwinInputs
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux linuxInputs;

        # Environment variables
        shellHook = ''
          # Rust environment
          export RUST_BACKTRACE=1
          export RUST_LOG=info

          # Tauri environment
          ${if pkgs.stdenv.isLinux then ''
            export PKG_CONFIG_PATH="${pkgs.openssl_3.dev}/lib/pkgconfig:${pkgs.webkitgtk_4_1}/lib/pkgconfig:${pkgs.gtk3}/lib/pkgconfig:$PKG_CONFIG_PATH"
            export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath linuxInputs}:$LD_LIBRARY_PATH"
          '' else ""}

          # Helmor data directory (optional override)
          # export HELMOR_DATA_DIR="$HOME/helmor-dev"

          # Helmor logging (optional override)
          # export HELMOR_LOG=debug

          echo "🚀 Helmor development environment loaded!"
          echo ""
          echo "📦 Available tools:"
          echo "  - bun $(bun --version)"
          echo "  - rustc $(rustc --version)"
          echo "  - cargo $(cargo --version)"
          echo "  - node $(node --version)"
          echo ""
          echo "🔨 Common commands:"
          echo "  bun install              # Install dependencies"
          echo "  bun run dev              # Start dev server (Tauri + Vite)"
          echo "  bun run dev:analyze      # Dev with perf HUD"
          echo "  bun run build            # Build frontend"
          echo "  bun run typecheck        # Type check"
          echo "  bun run lint             # Lint (biome + clippy)"
          echo "  bun run lint:fix         # Auto-fix lint issues"
          echo "  bun run test             # Run all tests"
          echo ""
          echo "🧪 Test commands:"
          echo "  bun run test:frontend    # Vitest tests"
          echo "  bun run test:sidecar     # Sidecar tests"
          echo "  bun run test:rust        # Rust tests"
          echo ""
        '';

      in
      {
        devShells.default = pkgs.mkShell {
          inherit buildInputs shellHook;

          # Additional native build inputs for linking
          nativeBuildInputs = with pkgs; [
            pkg-config
          ];
        };

        # Alias for convenience
        devShell = self.devShells.${system}.default;
      }
    );
}
